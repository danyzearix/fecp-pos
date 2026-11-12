#!/usr/bin/env bash
# FECP POS — restaurar un respaldo.
#
#   deploy/restore.sh ARCHIVO.dump --probar     Restaura en una base TEMPORAL, muestra conteos y la borra. No toca la real. (úsalo para verificar)
#   deploy/restore.sh ARCHIVO.dump              Reemplaza la base REAL por el respaldo (pide confirmación).
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
  log "OK: el respaldo se restaura bien. La base temporal se borra al terminar."
  exit 0
fi

echo "ATENCIÓN: esto REEMPLAZA todos los datos actuales de '$D' por los del archivo:"
echo "  $FILE"
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
