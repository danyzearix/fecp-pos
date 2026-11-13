#!/usr/bin/env bash
# FECP POS — restaurar un respaldo.
#
#   deploy/restore.sh ARCHIVO.dump --probar     Restaura en una base TEMPORAL, muestra conteos y la borra. No toca la real. (úsalo para verificar)
#   deploy/restore.sh ARCHIVO.dump              Reemplaza la base REAL por el respaldo (pide confirmación).
#
# Comprobantes: si junto al .dump está ARCHIVO_comprobantes.tar.gz (mismo nombre base), también se verifica (--probar) o
# se restaura en el volumen fecp_pos_uploads. Si no está, los comprobantes actuales NO se tocan.
#
# La restauración real: hace antes un respaldo de seguridad, detiene la app, restaura en una sola transacción
# (si algo falla, la base queda como estaba) y vuelve a encender la app.

set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.production}"
[ -f "$ENV_FILE" ] || { echo "ERROR: no existe $ENV_FILE" >&2; exit 1; }

FILE="${1:-}"; MODE="${2:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Uso: $0 ARCHIVO.dump [--probar]" >&2; exit 1; }

getvar() { local v; v=$(grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true); v="${v%\"}"; v="${v#\"}"; printf '%s' "$v"; }
log() { echo "$(date '+%F %T') $*"; }

DB_CONTAINER="${DB_CONTAINER:-fecp-pos-db}"
APP_IMAGE="${APP_IMAGE:-fecp-pos:latest}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-fecp_pos_uploads}"
RFILE="${FILE%.dump}_comprobantes.tar.gz"
[ -f "$RFILE" ] || RFILE=""
U="$(getvar POSTGRES_USER)"; D="$(getvar POSTGRES_DB)"
[ -n "$U" ] && [ -n "$D" ] || { echo "ERROR: faltan POSTGRES_USER / POSTGRES_DB en $ENV_FILE" >&2; exit 1; }

psql_() { docker exec -i "$DB_CONTAINER" psql -U "$U" -v ON_ERROR_STOP=1 "$@"; }

docker exec -i "$DB_CONTAINER" pg_restore --list < "$FILE" > /dev/null \
  || { echo "ERROR: ese archivo no es un respaldo válido." >&2; exit 1; }

COUNTS="SELECT 'usuarios' AS tabla, count(*) FROM users UNION ALL SELECT 'productos', count(*) FROM products
        UNION ALL SELECT 'clientes', count(*) FROM customers UNION ALL SELECT 'ventas', count(*) FROM sales
        UNION ALL SELECT 'logs', count(*) FROM logs;"

if [ "$MODE" = "--probar" ]; then
  T="${D}_restore_test"
  log "Restaurando en la base temporal $T (la real no se toca) ..."
  psql_ -d postgres -c "DROP DATABASE IF EXISTS \"$T\"" -c "CREATE DATABASE \"$T\""
  trap 'psql_ -d postgres -c "DROP DATABASE IF EXISTS \"$T\"" >/dev/null 2>&1 || true' EXIT
  docker exec -i "$DB_CONTAINER" pg_restore -U "$U" -d "$T" --no-owner --exit-on-error < "$FILE"
  echo "--- Contenido del respaldo ---"
  psql_ -d "$T" -c "$COUNTS"
  if [ -n "$RFILE" ]; then
    gzip -t "$RFILE" || { echo "ERROR: el archivo de comprobantes está dañado: $RFILE" >&2; exit 1; }
    echo "Comprobantes en el respaldo: $(tar -tzf "$RFILE" | grep -c '\.jpg$') archivo(s)"
  else
    echo "AVISO: no hay archivo de comprobantes junto a este respaldo."
  fi
  log "OK: el respaldo se restaura bien. La base temporal se borra al terminar."
  exit 0
fi

echo "ATENCIÓN: esto REEMPLAZA todos los datos actuales de '$D' por los del archivo:"
echo "  $FILE"
[ -n "$RFILE" ] && echo "  y TODOS los comprobantes por los de: $RFILE" || echo "  (sin archivo de comprobantes: los comprobantes actuales no se tocan)"
[ -n "$RFILE" ] && { gzip -t "$RFILE" || { echo "ERROR: el archivo de comprobantes está dañado." >&2; exit 1; }; }
read -r -p "Escribe RESTAURAR para continuar: " ANS
[ "$ANS" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }

log "Respaldo de seguridad de lo actual ..."
"$(dirname "$0")/backup.sh"

# Solo se detiene/arranca el servicio "app" de ESTE proyecto (fecp-pos). No se toca db, Traefik, n8n ni el servicio de Docker.
log "Deteniendo la app del POS ..."
docker compose --env-file "$ENV_FILE" stop app
trap 'log "Encendiendo la app del POS ..."; docker compose --env-file "$ENV_FILE" start app' EXIT

log "Restaurando ..."
docker exec -i "$DB_CONTAINER" pg_restore -U "$U" -d "$D" --clean --if-exists --no-owner \
  --single-transaction --exit-on-error < "$FILE"
log "OK: base restaurada."
psql_ -d "$D" -c "$COUNTS"

if [ -n "$RFILE" ]; then
  # Se extrae primero a una carpeta aparte y solo si salió bien se reemplaza el contenido del volumen.
  # Corre con la imagen del POS, como usuario node (dueño del volumen) y sin red.
  log "Restaurando comprobantes en el volumen $UPLOADS_VOLUME ..."
  docker run --rm -i --user node --network none -v "$UPLOADS_VOLUME:/data" "$APP_IMAGE" sh -c \
    'set -e; rm -rf /data/.restaurando; mkdir /data/.restaurando; tar -xzf - -C /data/.restaurando;
     find /data -mindepth 1 -maxdepth 1 ! -name .restaurando -exec rm -rf {} +;
     cp -a /data/.restaurando/. /data/; rm -rf /data/.restaurando' < "$RFILE"
  log "OK: comprobantes restaurados."
fi
