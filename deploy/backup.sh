#!/usr/bin/env bash
# FECP POS — respaldo diario de la base de datos.
#
#  1) pg_dump (formato comprimido) desde el contenedor "db" -> BACKUP_DIR/fecp_pos_AAAAMMDD_HHMMSS.dump
#  2) comprueba que el archivo se pueda leer (pg_restore --list)
#  2b) comprobantes de pago (volumen fecp_pos_uploads) -> BACKUP_DIR/fecp_pos_AAAAMMDD_HHMMSS_comprobantes.tar.gz
#      (mismo nombre base que el .dump: los dos forman UN respaldo y viajan juntos, cifrados, a Backblaze)
#  3) borra los respaldos locales de más de BACKUP_RETENTION_DAYS días (por defecto 14)
#  4) si BACKUP_RCLONE_REMOTE está definido, copia el respaldo FUERA del servidor con rclone (en un contenedor efímero)
#
# Uso (cron, ver DEPLOY.md):  /docker/fecp-pos/deploy/backup.sh
# Lee las variables de .env.production (solo las que necesita; no imprime ni registra ningún valor secreto).

set -euo pipefail
umask 077

# Desde cron el PATH es mínimo: se asegura que se encuentren docker y rclone. No depende de ningún usuario concreto
# (en este servidor corre en el crontab de root, porque solo root puede usar docker).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.production}"
[ -f "$ENV_FILE" ] || { echo "$(date '+%F %T') ERROR: no existe $ENV_FILE" >&2; exit 1; }

# Lee UNA variable del archivo (sin "source": así un valor raro nunca se ejecuta como comando)
getvar() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}
log() { echo "$(date '+%F %T') $*"; }

DB_CONTAINER="${DB_CONTAINER:-fecp-pos-db}"
PGUSER_="$(getvar POSTGRES_USER)"
PGDB_="$(getvar POSTGRES_DB)"
BACKUP_DIR="${BACKUP_DIR:-$(getvar BACKUP_DIR)}";                       BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-$(getvar BACKUP_RETENTION_DAYS)}";  RETENTION="${RETENTION:-14}"
REMOTE="${BACKUP_RCLONE_REMOTE:-$(getvar BACKUP_RCLONE_REMOTE)}"
REMOTE_RETENTION="${BACKUP_REMOTE_RETENTION_DAYS:-$(getvar BACKUP_REMOTE_RETENTION_DAYS)}"

[ -n "$PGUSER_" ] && [ -n "$PGDB_" ] || { log "ERROR: faltan POSTGRES_USER / POSTGRES_DB en $ENV_FILE" >&2; exit 1; }
case "$RETENTION" in ''|*[!0-9]*) log "ERROR: BACKUP_RETENTION_DAYS debe ser un número" >&2; exit 1;; esac

# Un solo respaldo a la vez
if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/fecp-pos-backup.lock"
  flock -n 9 || { log "Ya hay un respaldo en curso; se omite."; exit 0; }
fi

mkdir -p "$BACKUP_DIR"
NAME="fecp_pos_$(date +%Y%m%d_%H%M%S).dump"
FILE="$BACKUP_DIR/$NAME"
PARTIAL="$BACKUP_DIR/.$NAME.partial"
RNAME="${NAME%.dump}_comprobantes.tar.gz"
RFILE="$BACKUP_DIR/$RNAME"
RPARTIAL="$BACKUP_DIR/.$RNAME.partial"
APP_CONTAINER="${APP_CONTAINER:-fecp-pos-app}"
WARN=0
trap 'rm -f "$PARTIAL" "$RPARTIAL"' EXIT

# 1) Volcado. Se hace dentro del contenedor por su socket local: la clave de la base no sale de ahí.
log "Respaldando $PGDB_ ..."
docker exec "$DB_CONTAINER" pg_dump -U "$PGUSER_" -d "$PGDB_" -Fc --no-owner > "$PARTIAL"

# 2) Comprobación: no vacío y legible
[ -s "$PARTIAL" ] || { log "ERROR: el respaldo salió vacío" >&2; exit 1; }
docker exec -i "$DB_CONTAINER" pg_restore --list < "$PARTIAL" > /dev/null \
  || { log "ERROR: el respaldo no se puede leer (pg_restore --list falló)" >&2; exit 1; }
mv "$PARTIAL" "$FILE"
log "OK: $FILE ($(du -h "$FILE" | cut -f1))"

# 2b) Comprobantes: se empaquetan desde el contenedor de la app (que monta el volumen en /app/uploads)
if docker exec "$APP_CONTAINER" test -d /app/uploads 2>/dev/null; then
  if docker exec "$APP_CONTAINER" tar -czf - -C /app/uploads . > "$RPARTIAL" && gzip -t "$RPARTIAL"; then
    mv "$RPARTIAL" "$RFILE"
    log "OK: $RFILE ($(du -h "$RFILE" | cut -f1))"
  else
    log "ERROR: no se pudieron empaquetar los comprobantes" >&2
    RNAME=""; WARN=1
  fi
else
  log "ERROR: no se pudo leer el volumen de comprobantes (¿está detenido $APP_CONTAINER?). La base SÍ quedó respaldada." >&2
  RNAME=""; WARN=1
fi

# 3) Retención local
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'fecp_pos_*.dump' -o -name 'fecp_pos_*_comprobantes.tar.gz' \) -mtime "+$RETENTION" -print -delete \
  | sed 's/^/  borrado (vencido): /' || true

# 4) Copia fuera del servidor (opcional pero MUY recomendada)
if [ -z "$REMOTE" ]; then
  log "AVISO: BACKUP_RCLONE_REMOTE vacío: el respaldo solo existe en este servidor."
  exit $(( WARN ? 4 : 0 ))
fi
# rclone corre en un contenedor efímero (--rm): no se instala nada en el servidor. Su configuración (con las llaves
# del destino) vive en ./rclone/rclone.conf dentro de la carpeta del POS (permisos 600, fuera de git y de la imagen).
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.68.2}"
RCLONE_DIR="$PWD/rclone"
[ -f "$RCLONE_DIR/rclone.conf" ] || { log "ERROR: falta $RCLONE_DIR/rclone.conf (configura el remoto: ver DEPLOY.md, sección Respaldos)" >&2; exit 3; }
rclone_() { docker run --rm -v "$RCLONE_DIR:/config/rclone" -v "$BACKUP_DIR:/data:ro" "$RCLONE_IMAGE" "$@"; }
log "Enviando a $REMOTE ..."
for F in "$NAME" ${RNAME:+"$RNAME"}; do
  if ! rclone_ copy "/data/$F" "$REMOTE" --quiet; then
    log "ERROR: no se pudo enviar $F a $REMOTE (el local quedó guardado)" >&2
    exit 3
  fi
done
log "OK: enviado fuera del servidor."
# Retención remota solo si la pides explícitamente (por defecto NO se borra nada en el destino)
case "$REMOTE_RETENTION" in
  '') ;;
  *[!0-9]*) log "AVISO: BACKUP_REMOTE_RETENTION_DAYS no es un número; no se borra nada en el destino." ;;
  *) rclone_ delete "$REMOTE" --min-age "${REMOTE_RETENTION}d" --include 'fecp_pos_*.dump' --include 'fecp_pos_*_comprobantes.tar.gz' --quiet || log "AVISO: no se pudo limpiar el destino." ;;
esac
# Código 4 = la base quedó respaldada pero los comprobantes no (revise el log de arriba)
exit $(( WARN ? 4 : 0 ))
