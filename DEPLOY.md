# FECP POS — Despliegue en el servidor (Docker + Traefik)

Dominio: **https://pos.fecp.me**. El servidor ya tiene **Traefik** (modo `network_mode: host`, entrypoint `websecure`, resolvedor `letsencrypt`,
descubre contenedores por Docker con `exposedbydefault=false`) y **n8n** (red `n8n-fdod_default`). **Aquí no se toca nada de eso.**
El POS añade solo dos contenedores propios, **sin publicar ningún puerto**, y crea sus **propias redes**.

```
Internet ─443─▶ Traefik (host) ─▶ red fecp_pos_web ─▶ fecp-pos-app ─▶ red fecp_pos_internal ─▶ fecp-pos-db
                                   (solo la app)       :3000 (solo Docker)  (internal: sin salida)   :5432 (solo Docker)
```

| Recurso | Nombre (único, con prefijo `fecp-pos`) |
|---|---|
| Contenedores | `fecp-pos-app`, `fecp-pos-db` |
| Redes | `fecp_pos_internal` (`internal: true`, app↔db), `fecp_pos_web` (solo la app) |
| Volúmenes | `fecp_pos_pgdata` (base de datos), `fecp_pos_uploads` (comprobantes de pago, montado en `/app/uploads` de la app) |
| Router / servicio de Traefik | `fecp-pos-web` |
| Proyecto de Compose | `fecp-pos` |

**Todo vive en `/docker/fecp-pos`.** Ningún comando de esta guía reinicia Docker, Traefik ni n8n, ni cambia el firewall ni el Postgres existente.

> **Docker y `sudo`:** el usuario `deploy` no está en el grupo `docker`, así que los comandos de Docker llevan `sudo`. Para abreviar, en cada sesión:
> ```bash
> cd /docker/fecp-pos
> alias dc='sudo docker compose --env-file .env.production'
> ```
> **`--env-file .env.production` es obligatorio** en cada comando de Compose: Compose no lee ese archivo por sí solo para las `${…}` del `docker-compose.yml`.
> Sin él, la clave de la base y el dominio saldrían vacíos (el compose está hecho para fallar con un mensaje claro en ese caso).

---

## 1. Validar el compose SIN levantar nada

Estos comandos solo **leen** los archivos: no crean contenedores, redes ni volúmenes, no construyen ni descargan nada.

```bash
cd /docker/fecp-pos
alias dc='sudo docker compose --env-file .env.production'

# 1) ¿El archivo es válido y están todas las variables obligatorias? (no imprime nada si está bien)
dc config --quiet && echo "compose OK"
```
Si falta una variable, el error dice cuál (`falta POSTGRES_PASSWORD`, `falta POS_DOMAIN`…).

> ⚠ **No ejecutes `dc config` sin `--quiet` ni pegues su salida en ningún lado:** imprime el compose ya resuelto, **con los valores de `.env.production` (claves de Siigo, ePayco, base de datos)**. Usa solo los filtros de abajo.

```bash
# 2) Servicios, volumen e imagen
dc config --services        # esperado: app  y  db
dc config --volumes         # esperado: fecp_pos_pgdata  y  fecp_pos_uploads

# 3) No debe haber puertos publicados, host network, privileged, docker.sock ni capacidades extra (esperado: NO imprime nada)
dc config | grep -nE '^\s*(ports|network_mode|privileged|pid|cap_add|devices):|docker\.sock|/var/run'

# 4) Redes: esperado  fecp_pos_internal  y  fecp_pos_web  (y NINGUNA otra, ni la de n8n)
dc config | grep -nE '^\s+name: fecp_pos_(internal|web)$|internal: true|external'
dc config | grep -n 'n8n' ; echo "(vacío = bien)"

# 5) Etiquetas de Traefik (no contienen secretos)
dc config | grep -n 'traefik\.'
#   debe verse: traefik.docker.network=fecp_pos_web, Host(`pos.fecp.me`), entrypoints=websecure, certresolver=letsencrypt

# 6) La base solo en la red interna (esperado: el bloque de db muestra únicamente "internal")
dc config | sed -n '/^  db:/,/^  [a-z]*:$/p' | grep -nE 'networks:|internal|web'
```

Comprobar que **no hay choques de nombres** con lo que ya existe (solo lectura):

```bash
sudo docker ps -a --format '{{.Names}}' | grep -E '^fecp-pos-' ; echo "(vacío la primera vez = bien)"
sudo docker network ls --format '{{.Name}}' | grep -E '^fecp_pos_' ; echo "(vacío la primera vez = bien)"
sudo docker volume ls --format '{{.Name}}' | grep -E '^fecp_pos_' ; echo "(vacío la primera vez = bien)"
sudo docker ps --format '{{.Names}}'            # lo que ya corre (Traefik, n8n…): no debe aparecer nada con prefijo fecp-pos
```

Archivo de variables:

```bash
ls -l .env.production          # esperado: -rw------- (600)
```

Cuando todo coincida, sigue con la sección 2.

---

## 2. Primer despliegue

### 2.1 Antes de empezar
1. **DNS:** registro **A** de `pos.fecp.me` hacia la IP del servidor (Traefik necesita resolverlo para sacar el certificado).
2. **Memoria (importante, sección 7):** el build de la imagen consume mucha RAM y el servidor comparte recursos con n8n y no tiene swap. Léela antes del primer `build`.

### 2.2 Variables
```bash
cd /docker/fecp-pos
install -m 600 .env.production.example .env.production    # se crea A MANO en el servidor, ya con permisos 600 (solo su dueño)
nano .env.production
```
Genera los secretos **en el servidor**; no los pegues en chats ni los subas a git:
```bash
openssl rand -hex 24    # -> POSTGRES_PASSWORD   (hexadecimal a propósito: va dentro de una URL)
openssl rand -hex 48    # -> SESSION_SECRET      (distinto al de desarrollo)
```
Llena también WooCommerce, Siigo, ePayco y los datos del negocio. **Deja `SIIGO_TEST_MODE=true` y `EPAYCO_TEST_MODE=true`** hasta terminar las pruebas (paso a real: sección 13 del README).

### 2.3 Construir y encender
```bash
dc build                  # construye la imagen (ver sección 7: memoria)
dc up -d
dc ps                     # app y db deben quedar "running" / "healthy"

# Tablas y administrador (la primera vez; db:setup se puede repetir sin perder datos)
dc exec app node db/setup.mjs
dc exec app node db/seed.mjs        # interactivo: pide nombre, correo y contraseña (esta última no se muestra ni se registra)
```
> `docker compose exec` ya abre un terminal interactivo (necesario para que `seed.mjs` pueda ocultar la contraseña al escribirla).

Luego, en el navegador: `https://pos.fecp.me` → entra como admin → **Productos → Sincronizar productos** (≈3 minutos la primera vez).
Si la sincronización se corta, revisa los tiempos de respuesta (`respondingTimeouts`) del entrypoint de Traefik.

### 2.4 Actualizar a una versión nueva
```bash
cd /docker/fecp-pos
sudo /docker/fecp-pos/deploy/backup.sh   # respaldo antes de actualizar
git pull                         # o copia los archivos nuevos
dc build && dc up -d             # recrea solo fecp-pos-app (y db si cambió); crea los volúmenes nuevos si faltan
dc exec app node db/setup.mjs    # aplica cambios de tablas si los hay (idempotente: no borra datos)
```
Si `.env.production.example` trae variables nuevas, cópialas a tu `.env.production` (y vuelve a `dc up -d`). La última versión agrega `PRICE_HISTORY_HOURS=72` (ventana de validación de precios de la caja).

> **`db:setup` es obligatorio en esta actualización:** crea `product_price_history` con la línea base de los 701 productos, el disparador sobre `products` y las columnas de revisión de `sales`. Verifica: `dc exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT (SELECT count(*) FROM products), (SELECT count(*) FROM product_price_history WHERE valid_to IS NULL)"'` (las dos cifras deben ser iguales).

> **Clientes de Siigo (última versión):** `db:setup` es **obligatorio**: agrega a `customers` las columnas `siigo_id`, `active` y `search_name`, amplía el tipo de documento a cualquier código de la DIAN, crea los índices de búsqueda (`pg_trgm`, que viene con Postgres) y la tabla `customer_sync_runs`. No hay variables nuevas en `.env.production`. Después de actualizar: entra como admin a **Admin → Clientes** y pulsa **Sincronizar clientes** (la primera vez trae todo, ~5 minutos; sigue funcionando la caja mientras tanto). No hace falta cron: cuando quieras refrescar, pulsa el botón (trae solo lo nuevo).

### 2.4.1 Scripts de `db/` en el servidor
La imagen incluye `db/` (`setup`, `seed`, `iva-report`, `siigo-test-docs`). Para los reportes se usa un contenedor **temporal**
(`run --rm`), con `--no-deps` (no toca la base ni la app en marcha) y **`-l traefik.enable=false`** (si no, Traefik le mandaría
tráfico de la web mientras dura):
```bash
# Documentos de PRUEBA creados en Siigo (para anularlos antes de abrir)
dc run --rm --no-deps -l traefik.enable=false app node db/siigo-test-docs.mjs

# Productos con IVA distinto entre WooCommerce y Siigo → CSV guardado FUERA del contenedor (en /docker/fecp-pos)
dc run --rm -T --no-deps -l traefik.enable=false app node db/iva-report.mjs --stdout > productos-iva-diferente.csv
```

### 2.5 Comandos útiles (todos limitados al POS)
```bash
dc logs -f app                   # logs de la app
dc restart app                   # reinicia SOLO la app del POS
dc exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'     # consola de la base
```
**No uses** `systemctl restart docker`, `docker restart traefik`, `docker system prune` ni `docker network prune` en este servidor: afectarían a otros servicios.

---

## 3. Comprobaciones después de desplegar

### 3.1 HTTPS y la app
```bash
curl -sI https://pos.fecp.me/login | head -3        # HTTP/2 200 y certificado válido
```

### 3.2 ¿Traefik entrega `x-forwarded-host` y `x-forwarded-proto` a la app?
Traefik los añade solo, pero **compruébalo**: de ellos depende cómo se arma la dirección de regreso de ePayco cuando el navegador no manda `Origin`.
Con un contenedor temporal que solo muestra los encabezados que recibe (usa la red del POS, **no** la de n8n; se borra solo al detenerlo):

```bash
sudo docker run -d --rm --name fecp-pos-whoami --network fecp_pos_web \
  -l traefik.enable=true \
  -l traefik.docker.network=fecp_pos_web \
  -l 'traefik.http.routers.fecp-pos-whoami.rule=Host(`pos.fecp.me`) && PathPrefix(`/__whoami`)' \
  -l traefik.http.routers.fecp-pos-whoami.priority=1000 \
  -l traefik.http.routers.fecp-pos-whoami.entrypoints=websecure \
  -l traefik.http.routers.fecp-pos-whoami.tls=true \
  -l traefik.http.routers.fecp-pos-whoami.tls.certresolver=letsencrypt \
  -l traefik.http.services.fecp-pos-whoami.loadbalancer.server.port=80 \
  traefik/whoami:v1.10.2

curl -s https://pos.fecp.me/__whoami | grep -i -E '^(Host|X-Forwarded-(Host|Proto|For)):'
sudo docker stop fecp-pos-whoami          # BÓRRALO al terminar
```
Debes ver `X-Forwarded-Host: pos.fecp.me` y `X-Forwarded-Proto: https`. Si falta alguno, la app caerá en `Host` y en el protocolo interno (`http`): revisa Traefik antes de seguir.

### 3.3 Dirección de regreso de ePayco (`APP_PUBLIC_URL`)
Con `APP_PUBLIC_URL=https://pos.fecp.me` las URL se arman así:

| Flujo | URL a la que vuelve el cliente | De dónde sale |
|---|---|---|
| Caja (cobro ePayco) | `https://pos.fecp.me/caja` | `Origin` del navegador (si falta, `x-forwarded-*`) |
| Kiosco | `https://pos.fecp.me/kiosco` (o `EPAYCO_RESPONSE_URL` si la defines) | ídem |
| Enlace/QR de pago | `https://pos.fecp.me/pagar/<código>/respuesta` | `APP_PUBLIC_URL` |
| **Confirmación (webhook)** | **`https://pos.fecp.me/api/epayco/confirmacion`** | `APP_PUBLIC_URL` |

Comprobar de punta a punta (con `EPAYCO_TEST_MODE=true` y la tarjeta de prueba del README, sección 10):

1. **Configuración** (admin) → *Autoservicio / ePayco* debe decir *“con dominio público (https://pos.fecp.me): webhook ACTIVO, QR de pago en la caja”*.
2. El webhook responde (sin datos contesta **400**; un **404** significa que `APP_PUBLIC_URL` está vacío):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://pos.fecp.me/api/epayco/confirmacion     # esperado: 400
   ```
3. Haz un cobro de prueba en la caja con ePayco. Al pagar, el navegador debe **volver solo** a `https://pos.fecp.me/caja` y la venta pasar a *Pago recibido*.
4. Mira qué URLs usó el sistema (los logs no guardan llaves):
   ```bash
   dc exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT created_at, level, message, detail->>'"'"'response_url'"'"' AS response_url FROM logs WHERE type = '"'"'pago'"'"' ORDER BY id DESC LIMIT 8;"'
   ```
   (O en el panel: **Admin → Logs**, tipo *pago*.) `response_url` debe empezar por `https://pos.fecp.me/`. Si ves *“ePayco rechazó la URL de respuesta”* o `response_url` vacío, revisa 3.2.
5. **URL de confirmación en ePayco:** el sistema la envía en **cada cobro** (`https://pos.fecp.me/api/epayco/confirmacion`), así que no depende de que la configures en el panel. Si el panel pide una URL de confirmación general, pon **exactamente esa**.
   Para ver que ePayco sí la llama: la venta debe pasar a *pagado* aunque cierres el navegador antes de que vuelva a la caja (eso solo lo logra el webhook).

### 3.4 Zona horaria
La app y la base usan `America/Bogota` (`TZ` en ambos contenedores y `timezone=America/Bogota` en Postgres), y el código además la fija **explícitamente** en cada consulta de fechas. Para verlo:
```bash
dc exec app date
dc exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW timezone; SELECT now();"'     # America/Bogota
```

---

## 4. Siigo y WooCommerce: llamadas desde la IP del servidor

Desde ahora **Siigo y WooCommerce reciben las llamadas desde la IP pública del servidor**, no desde la del local. Si alguno filtra por IP (o su firewall/WAF bloquea servidores), fallará aunque las credenciales estén bien.

IP desde la que salen las llamadas:
```bash
dc exec app node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```
Diagnóstico, en orden:
1. **Admin → Configuración → Probar conexiones**: muestra el error de cada servicio sin mostrar credenciales.
2. Desde dentro del contenedor, para ver el código HTTP crudo:
   ```bash
   # Siigo (sin credenciales debe responder 4xx en JSON; un 403/timeout con HTML o conexión cortada es bloqueo)
   dc exec app node -e "fetch('https://api.siigo.com/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(async r=>console.log(r.status,(await r.text()).slice(0,120)))"
   # WooCommerce
   dc exec app node -e "fetch(process.env.WOO_URL+'/wp-json/').then(async r=>console.log(r.status,(await r.text()).slice(0,120)))"
   ```
3. Cómo interpretar:

   | Respuesta | Qué significa |
   |---|---|
   | Siigo `400/401/422` con JSON | Llegas a Siigo; el problema (si hay) son credenciales. |
   | `403` con una página HTML (Cloudflare, Wordfence, ModSecurity…) | **Bloqueo por IP/WAF**: autoriza la IP del servidor en esa herramienta. |
   | Timeout o *connection reset* | Firewall del lado de la tienda, o salida bloqueada en el servidor. |
   | `401` JSON de WooCommerce | La tienda responde; revisa las llaves. |
4. Para WooCommerce, quien administre el hosting/WAF de la tienda debe permitir la IP del paso anterior. Para Siigo, pide a su soporte que no la bloquee.

---

## 5. Respaldos (Backblaze B2 cifrado con rclone crypt)

`deploy/backup.sh` hace cada corrida:
1. `pg_dump` comprimido desde `fecp-pos-db` → `/docker/fecp-pos/backups/fecp_pos_AAAAMMDD_HHMMSS.dump` (permisos 600).
2. Verifica que el archivo se pueda leer.
3. **Comprobantes de pago** (volumen `fecp_pos_uploads`) → `fecp_pos_AAAAMMDD_HHMMSS_comprobantes.tar.gz`, con el **mismo nombre base**: los dos archivos forman un solo respaldo. Si no se pudo (p. ej. la app estaba detenida), la base igual queda respaldada y el script termina con código 4.
4. Borra los respaldos locales de más de **14 días** (`BACKUP_RETENTION_DAYS`).
5. Si `BACKUP_RCLONE_REMOTE` está definido, envía **los dos archivos cifrados** a Backblaze B2. Si el envío falla, sale con error (código 3) y el respaldo local queda.

**rclone no se instala en el servidor:** corre como contenedor efímero (`rclone/rclone`, se borra al terminar) y su configuración vive en `/docker/fecp-pos/rclone/rclone.conf`.

### 5.1 Preparar Backblaze (cuenta de FECP)
1. Crea un **bucket privado** (p. ej. `fecp-pos-respaldos`).
2. Crea una **Application Key restringida a ese bucket** (no uses la *Master Application Key*), con permisos de leer y escribir (y borrar solo si usarás `BACKUP_REMOTE_RETENTION_DAYS`). Anota el *keyID* y la *applicationKey* (solo se muestra una vez).

### 5.2 Configurar los remotos (interactivo; ninguna clave queda en el historial de comandos)
```bash
cd /docker/fecp-pos
mkdir -p rclone backups && chmod 700 rclone backups
sudo docker run --rm -it -v /docker/fecp-pos/rclone:/config/rclone rclone/rclone:1.68.2 config
```
Dentro de rclone:
1. `n` (nuevo) → nombre **`fecp-b2`** → tipo **`b2`** → pega *keyID* (account) y *applicationKey* (key) → el resto por defecto.
2. `n` (nuevo) → nombre **`fecp-b2-cifrado`** → tipo **`crypt`**:
   - `remote`: `fecp-b2:fecp-pos-respaldos`
   - `filename_encryption`: `standard` · `directory_name_encryption`: `true`
   - **`password`**: elige *g* (genera una aleatoria) y **cópiala**.
   - **`password2` (salt)**: también *g* y **cópiala**. (Hacen falta **las dos**.)
3. `q` para salir, y protege el archivo:
   ```bash
   sudo chmod 600 /docker/fecp-pos/rclone/rclone.conf
   ```

### 5.3 Dónde guardar la contraseña de cifrado (fuera del servidor)
- **Guarda `password` y `password2` en el gestor de contraseñas de FECP y en una copia impresa bajo llave** (caja fuerte/oficina). También el *keyID* de B2.
- **Si pierdes esas dos contraseñas, los respaldos en B2 son irrecuperables**: ni Backblaze ni nadie puede abrirlos.
- **No** las guardes solo en el servidor, ni en `.env.production`, ni en git, ni en chats, ni en el mismo equipo que los respaldos.
- Ten presente que `rclone.conf` del servidor sí contiene estas contraseñas (ofuscadas, **no** cifradas): quien entre al servidor puede descifrar los respaldos. Por eso la application key de B2 va restringida a ese bucket.

### 5.4 Activarlo y probarlo
En `.env.production`:
```
BACKUP_RCLONE_REMOTE=fecp-b2-cifrado:pos
BACKUP_REMOTE_RETENTION_DAYS=180       # NO más de RECEIPT_RETENTION_DAYS (ver 5.7). Vacío = no se borra nada en B2
```
```bash
sudo /docker/fecp-pos/deploy/backup.sh                       # a mano, una vez
sudo docker run --rm -v /docker/fecp-pos/rclone:/config/rclone rclone/rclone:1.68.2 ls fecp-b2-cifrado:pos        # lista el .dump (nombre real)
sudo docker run --rm -v /docker/fecp-pos/rclone:/config/rclone rclone/rclone:1.68.2 ls fecp-b2:fecp-pos-respaldos  # en B2 se ve con nombre ilegible: está cifrado
```

### 5.5 Programarlo (crontab de **root**)
El usuario `deploy` no pertenece al grupo `docker`, así que el cron va en el de root:
```bash
sudo crontab -e
# todos los días 03:15 (hora del servidor):
15 3 * * * /docker/fecp-pos/deploy/backup.sh >> /docker/fecp-pos/backups/backup.log 2>&1
```
`backup.sh` no depende de ningún usuario concreto; solo necesita poder usar Docker.

### 5.6 Restaurar
**Primero verifica el respaldo (no toca la base real):**
```bash
sudo /docker/fecp-pos/deploy/restore.sh /docker/fecp-pos/backups/fecp_pos_20261112_031500.dump --probar
```
Restaura en una base temporal, muestra cuántos usuarios/productos/ventas contiene y la borra; si junto al `.dump` está su `_comprobantes.tar.gz`, verifica que no esté dañado y cuenta las fotos. **Hazlo de vez en cuando**: un respaldo no probado no es un respaldo.

**Si el respaldo está solo en B2 (cifrado):**
```bash
# (en el servidor del POS o en cualquier equipo con Docker)
# a) Si no existe rclone.conf: vuelve a crear los dos remotos (sección 5.2) con el MISMO keyID/applicationKey de B2
#    y las MISMAS password y password2 del gestor de contraseñas. Si no coinciden, no se puede descifrar.
# b) Ver qué hay (nombres ya descifrados):
sudo docker run --rm -v /docker/fecp-pos/rclone:/config/rclone rclone/rclone:1.68.2 ls fecp-b2-cifrado:pos
# c) Bajar y descifrar uno a la carpeta de respaldos:
sudo docker run --rm -v /docker/fecp-pos/rclone:/config/rclone -v /docker/fecp-pos/backups:/data rclone/rclone:1.68.2 \
  copy fecp-b2-cifrado:pos /data --include 'fecp_pos_20261112_031500*'      # el .dump y su _comprobantes.tar.gz
# d) Verificar y luego restaurar:
sudo /docker/fecp-pos/deploy/restore.sh /docker/fecp-pos/backups/fecp_pos_20261112_031500.dump --probar
```

**Restauración real** (reemplaza TODOS los datos actuales):
```bash
sudo /docker/fecp-pos/deploy/restore.sh /docker/fecp-pos/backups/fecp_pos_20261112_031500.dump
```
Pide escribir `RESTAURAR`. Hace antes un respaldo de seguridad de lo actual, **detiene y vuelve a arrancar solo `fecp-pos-app`** (`docker compose stop app` / `start app` del proyecto `fecp-pos`), restaura en una sola transacción (si algo falla, la base queda como estaba).
Si está el `_comprobantes.tar.gz` del mismo respaldo, **reemplaza también las fotos** del volumen `fecp_pos_uploads` (las extrae primero aparte y solo si salió bien reemplaza; usa la imagen del POS, como usuario `node` y sin red). Si no está, las fotos actuales no se tocan.

### 5.7 Comprobantes y retención de 180 días
- La app borra sola (tarea diaria, con bloqueo en la base para no correr dos veces) los **archivos** de comprobantes con más de `RECEIPT_RETENTION_DAYS` (180) días desde la fecha de la venta. El registro queda como *Eliminado por retención* con su fecha, y en **Admin → Logs** queda cuántos borró.
- Como cada respaldo lleva las fotos, **`BACKUP_REMOTE_RETENTION_DAYS` no debe superar 180**: si fuera mayor, una foto ya eliminada en el POS seguiría existiendo en Backblaze más tiempo del permitido. Con 180 en los dos, ninguna copia vive más de ~180 días (+ la retención local de 14).
- Si Backblaze tiene activado *versionado* o *Object Lock* en el bucket, también limita ahí la vida de los archivos ocultos/borrados (*Lifecycle Settings*) a ≤ 180 días.

**Servidor nuevo desde cero:** repite la sección 2 hasta `dc up -d`, **omite `seed.mjs`**, y ejecuta `restore.sh` con el respaldo.

---

## 6. Antes de abrir al público
1. Prueba de punta a punta con los modos de prueba (caja, kiosco, enlace de pago, regreso a la caja, factura de prueba en Siigo).
2. Deja la base en cero (README sección 12; en Docker). **Irreversible**: haz antes un respaldo (`deploy/backup.sh`).
   ```bash
   dc exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE sale_receipts, payment_refs, sale_items, sales, logs RESTART IDENTITY; ALTER SEQUENCE kiosk_sale_seq RESTART WITH 1;"'
   dc exec app sh -c 'rm -rf /app/uploads/comprobantes/*'      # y las fotos de prueba
   ```
3. Pasa a real **solo cuando lo decidas** (README sección 13: `SIIGO_TEST_MODE=false`, `EPAYCO_TEST_MODE=false`, `EPAYCO_SIIGO_PAYMENT_ID` real y `SIIGO_PAYMENT_CREDITO_ID` real si se vende a crédito). Tras editar `.env.production`: `dc up -d` recrea la app con los valores nuevos.
4. **Las cajas y el kiosco deben iniciar sesión de nuevo** (la sesión es por dirección; cambian de `127.0.0.1` a `pos.fecp.me`). Actualiza sus accesos directos de Chrome (README, sección 7).
5. Primera copia: corre `backup.sh` a mano y verifícala con `restore.sh --probar`.

---

## 7. Memoria del build (el servidor comparte RAM con n8n y no tiene swap)

**Medido en el equipo de desarrollo** (Windows, muchos núcleos; no es idéntico al servidor): `next build` sin caché llegó a un pico de **≈2,1 GB** sumando 14 procesos de Node. En el servidor (2 vCPU) Next lanza menos procesos y debería usar menos, pero **no está medido ahí**. El servidor ya en marcha usa poco: **≈90 MB** en reposo tras 30 peticiones.

Qué hay puesto y qué no:
- **Límites en ejecución** (`docker-compose.yml`): app `mem_limit: 768m`, db `mem_limit: 512m`. Si la app se pasara, Docker reinicia **su** contenedor, no a n8n.
- **En el build** el `Dockerfile` limita el montón de JavaScript (`--max-old-space-size=1536`). **Eso no limita la memoria nativa de Turbopack**, y no hay una forma sencilla de poner un tope de RAM al build dentro de Docker. Es la parte que puede, en el peor caso, hacer que el kernel mate otro proceso (incluido n8n).

Qué hacer:
1. **Antes de construir**, mira la memoria libre: `free -m` → exige **≥ 3 GB en la columna *available***. Construye en un horario tranquilo de n8n.
2. **Opción más segura: construir fuera del servidor** (en tu PC con Docker) y subir la imagen ya hecha, sin gastar RAM del servidor:
   ```bash
   # en tu PC, en la carpeta del proyecto
   docker build -t fecp-pos:latest .
   docker save fecp-pos:latest | gzip | ssh deploy@SERVIDOR "gunzip | sudo docker load"
   # en el servidor
   dc up -d --no-build
   ```
3. Si el servidor se queda corto con frecuencia, crear **swap** es una decisión de administración del servidor (afecta a todo): consúltalo antes; esta guía no lo hace.
