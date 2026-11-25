# FECP POS (BETA)

Punto de venta web para FECP (Colombia): caja con lector de códigos de barras, catálogo sincronizado con WooCommerce,
facturación electrónica con Siigo, tirilla de 80 mm, **pago electrónico con ePayco (Davipay)**, **autoservicio (kiosco)** y
funcionamiento sin internet en la caja (las ventas se guardan en el equipo y se envían al volver la conexión).

**Stack:** Next.js 16 (App Router) + TypeScript + Tailwind CSS · PostgreSQL (`pg`, SQL directo) · `bcryptjs` · `jose` · `qrcode`.

> **En producción** el sistema corre en un servidor con Docker detrás de Traefik, en **https://pos.fecp.me**. Todo el procedimiento
> (instalación, comprobaciones, respaldos y restauración) está en **[DEPLOY.md](DEPLOY.md)**. Las secciones 1–6 de este README son para
> trabajar en un equipo local de desarrollo.

---

## 1. Requisitos

| Requisito | Versión |
|---|---|
| Windows | 10 u 11 |
| Node.js | 20 o superior (probado con 22) |
| PostgreSQL | 14 o superior (probado con 16) |
| Google Chrome | Reciente (para imprimir sin diálogo y para el kiosco) |
| Impresora térmica | 80 mm, con su controlador de Windows instalado |
| Cuentas | WooCommerce (claves REST), Siigo (usuario y clave de API) y ePayco/Davipay (llaves de API) |

## 2. Instalar PostgreSQL y crear la base

1. Descarga el instalador desde <https://www.postgresql.org/download/windows/> y ejecútalo. Guarda la **contraseña del usuario `postgres`**; el puerto por defecto es 5432.
2. Crea la base de datos (PowerShell):

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE fecp_pos"
```

(Cambia `16` por tu versión. Te pedirá la contraseña de `postgres`.)

## 3. Instalar el proyecto

```powershell
cd "C:\Users\Dany Muñoz\Desktop\FECP-POS"
npm install
Copy-Item .env.example .env.local
```

## 4. Llenar `.env.local`

Abre `.env.local` y completa los valores. **Nunca subas este archivo a un repositorio ni lo compartas.**

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:CLAVE@localhost:5432/fecp_pos` |
| `SESSION_SECRET` | Texto largo aleatorio (mín. 32 caracteres). Si lo cambias, todos deben volver a iniciar sesión |
| `COOKIE_SECURE` | `false` si abres la app por `http://`; `true` solo si usas HTTPS |
| `WOO_URL`, `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET` | Tienda WooCommerce y claves de la API REST (solo lectura) |
| `SIIGO_USERNAME`, `SIIGO_ACCESS_KEY` | Credenciales de la API de Siigo |
| `SIIGO_PARTNER_ID` | Nombre de la integración, 3–100 letras/números, sin espacios |
| `SIIGO_DOCUMENT_ID` | Comprobante de factura electrónica de venta (FECP: `35123`) |
| `SIIGO_TEST_DOCUMENT_ID` | Comprobante NO electrónico para pruebas (FECP: `6503`) |
| `SIIGO_PAYMENT_CREDITO_ID` | Forma de pago de Siigo para el **Crédito FECP** (una con `due_date=true`; "Crédito" suele ser `1667`). Vacía + `SIIGO_TEST_MODE=false` = el sistema se **niega** a facturar ventas a crédito |
| `SIIGO_SELLER_ID` | Vendedor de Siigo por defecto (se usa si el usuario no tiene `siigo_seller_id`) |
| `SIIGO_TEST_MODE` | `true` = documentos de prueba sin DIAN · `false` = **facturas electrónicas reales** |
| `UVT_VALUE` | Valor de la UVT del año (se usa para el tope de 5 UVT solo cuando `CONSUMIDOR_FINAL_SIN_TOPE=false`) |
| `CONSUMIDOR_FINAL_SIN_TOPE` | `true` (por defecto) = se puede facturar a Consumidor final sin importar el monto (Res. DIAN 165/2023, art. 11, num. 3.3). `false` = tope de 5 UVT: por encima hay que identificar al cliente. Ver §11f |
| `POS_ADDRESS`, `POS_STATE_CODE`, `POS_CITY_CODE` | Dirección y códigos DANE del punto de venta (dirección por defecto cuando un cliente no tiene) |
| `NEXT_PUBLIC_CAJA_PREFIX` | Prefijo del número de venta de esta caja (`C01` → `C01-000123`) |
| `NEGOCIO_*` | Nombre, NIT, dirección y teléfono que salen en la tirilla |
| `RESOLUCION_DIAN_*` | Número, fecha, rango y vigencia de la resolución de facturación (salen en la tirilla; Siigo no los entrega por API). `RESOLUCION_DIAN_RANGO`: se leen los dos últimos números como «desde» y «hasta» (ej. `1-50000`) |
| `TICKET_REGIMEN`, `TICKET_ACTIVIDAD_ECONOMICA`, `TICKET_PROVEEDOR_SOFTWARE`, `TICKET_NOMBRE_SOFTWARE` | Opcionales: avisos legales al pie de la tirilla. Por defecto «Régimen Especial», «8559», «Siigo S.A.S - Nit: 830.048.145-8» y «Siigo Nube» |
| `REQUIRE_RECEIPT_PHOTO` | `false` (por defecto) = la foto del comprobante es **opcional** con Transferencia y Tarjeta · `true` = vuelve a ser obligatoria con Transferencia (la referencia y la casilla de verificación son obligatorias siempre) |
| `CREDITO_PLAZO_DIAS` | Plazo **único** del Crédito FECP en días (**60** por defecto, lo autorizó gerencia). El servidor rechaza cualquier otro |
| `SOFTWARE_NOMBRE`, `SOFTWARE_FABRICANTE` | Pie de la factura |
| `EPAYCO_PUBLIC_KEY`, `EPAYCO_PRIVATE_KEY` | Llaves de la API de ePayco (APIFY): crean el cobro |
| `EPAYCO_P_CUST_ID_CLIENTE`, `EPAYCO_P_KEY` | Identifican al comercio y firman/verifican las transacciones |
| `EPAYCO_TEST_MODE` | `true` = pagos de prueba (no cobran dinero real) · `false` = **cobros reales** |
| `EPAYCO_SIIGO_PAYMENT_ID` | Id de la forma de pago “ePayco” en Siigo. `5798` solo sirve para pruebas (ver sección 11) |
| `APP_PUBLIC_URL` | Dominio público con HTTPS (solo en el deploy). Vacío = modo local: sin webhook y sin QR de pago |
| `EPAYCO_CONFIRMATION_URL`, `EPAYCO_RESPONSE_URL` | Opcionales. Por defecto salen de `APP_PUBLIC_URL` / de la propia pantalla |
| `EPAYCO_POLL_SECONDS` | Cada cuántos segundos el servidor consulta a ePayco por su cuenta los cobros que siguen esperando (**20** por defecto; mínimo 5; `0` = apagada). Ver §10b |
| `EPAYCO_TRUST_SIGNED_WEBHOOK` | `false` (por defecto). `true` = factura **automáticamente** con el webhook firmado cuando no hay referencia larga para consultar, solo si se cumplen todas las condiciones de §10c. ⚠ Riesgo: no se consulta a ePayco |
| `EPAYCO_ALT_REF_LOOKUP` | `false` (por defecto). `true` = prueba además consultar a ePayco con `x_transaction_id` y `x_ref_payco` (no documentado; experimental, §10c) |
| `KIOSCO_IMPRESORA` | `true` = el kiosco imprime la tirilla al terminar · `false` = solo muestra el número de factura |

> ⚠️ **`SIIGO_TEST_MODE=true` sigue creando documentos en la contabilidad real de Siigo** (no electrónicos, “PRUEBA POS - ELIMINAR”).
> Para listarlos y pedir que los anulen: `npm run siigo:pruebas`.

> 🔒 Las llaves de ePayco viven **solo** en `.env.local`: nunca se envían al navegador ni se escriben en los logs.

## 5. Preparar la base de datos

```powershell
npm run db:setup     # crea/actualiza las tablas (se puede repetir sin perder datos). Tras una actualización también crea las columnas e índices de clientes (§11e)
npm run db:seed      # crea el administrador (pide correo y contraseña, mín. 12 caracteres) y el cliente Consumidor final
```

## 6. Ejecutar

**Desarrollo** (con recarga automática):

```powershell
npm run dev
```

**Producción** (en la caja):

```powershell
npm run build
npm start
```

Abre <http://127.0.0.1:3000>. Para otro puerto: `npm start -- -p 3100`. Tras cambiar `.env.local` hay que reiniciar el servidor.

> Usa **`127.0.0.1`** y no `localhost` si vas a cobrar con ePayco: ePayco rechaza `localhost` como dirección de regreso y, sin ella, al terminar el pago el navegador
> no vuelve solo a la caja. (La pantalla del kiosco se corrige sola; en la caja basta con abrirla por `127.0.0.1`. La cookie de sesión es por dirección: la primera vez hay que iniciar sesión de nuevo.)

Para que arranque solo al encender el equipo, crea una tarea en el *Programador de tareas* de Windows que ejecute `npm start` en la carpeta del proyecto.

### Primer uso

1. Entra como administrador → **Productos** → **Sincronizar productos** (la primera vez tarda unos 3 minutos: trae WooCommerce y consulta el IVA de cada producto en Siigo).
2. **Usuarios** → crea los cajeros y asigna su **vendedor de Siigo** (`siigo_seller_id`). Para el autoservicio crea además un usuario con rol **Cliente (autoservicio)**.
3. **Configuración** → *Probar conexión WooCommerce* y *Probar conexión Siigo*; revisa la sección **Autoservicio / ePayco** (muestra qué falta, nunca las llaves).
4. Pon tu logo en `public/logo.webp` (se ve en el login y en la barra lateral).

## 7. Accesos directos de Chrome (pantalla completa e impresión sin diálogo)

Una página web **no puede ponerse en pantalla completa sola**: el navegador exige un toque o un clic. Por eso, en el punto de venta
la forma correcta de que abra siempre a pantalla completa es un acceso directo de Chrome. (Dentro de la app hay además un botón
**Pantalla completa** en la barra lateral y en el encabezado de administración, y el kiosco muestra “Toque para iniciar”.)

Crea cada acceso directo así: clic derecho en el escritorio → **Nuevo → Acceso directo** → pega el destino → ponle nombre.
Ajusta la ruta si tu Chrome está en otra carpeta.

**Caja** (ventana propia, sin barras del navegador, e imprime la tirilla sin diálogo):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --app=https://pos.fecp.me/caja --kiosk-printing --user-data-dir="C:\FECP-POS-Chrome"
```

**Autoservicio** (modo kiosco real: pantalla completa, sin barras y sin forma de salir con el mouse):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --app=https://pos.fecp.me/kiosco --user-data-dir="C:\FECP-KIOSCO-Chrome"
```

Agrega `--kiosk-printing` al del autoservicio solo si pusiste `KIOSCO_IMPRESORA=true`.

> **⚠ Al pasar a `https://pos.fecp.me`, todas las cajas y el kiosco deben iniciar sesión de nuevo.** La sesión (cookie) y el tema
> claro/oscuro son por dirección: no se trasladan desde `127.0.0.1`. Sustituye los accesos directos viejos por estos y entra una vez con tu usuario
> (en el kiosco, con el usuario del rol Cliente).

Notas:
- **Desarrollo local:** para trabajar en tu equipo usa `http://127.0.0.1:3000/caja` y `/kiosco` (la misma línea cambiando la dirección). **Usa `127.0.0.1`, no `localhost`**: ePayco rechaza `localhost` como dirección de regreso (sección 10). Con el dominio real no hay ese problema.
- `--user-data-dir` crea un perfil aparte, así la opción se aplica aunque tengas otro Chrome abierto (si no, Chrome la ignora).
  La primera vez tendrás que iniciar sesión en ese perfil. Usa **perfiles distintos** para la caja y el kiosco: cada uno guarda su
  propia sesión (y su propio tema claro/oscuro).
- `--kiosk-printing` manda la tirilla directo a la impresora predeterminada, sin ventana de impresión.
- Para que todo arranque al encender el equipo, pon el acceso directo en la carpeta `shell:startup`.

### Tema claro / oscuro

El botón de **Modo oscuro** está abajo en la barra lateral (caja e historial), en el encabezado de administración y en una esquina
del login. La preferencia se guarda **en ese equipo** (no en la cuenta) y se aplica antes de pintar la pantalla, sin parpadeo.
Si no se ha elegido nada, queda en claro. El kiosco **no** tiene el botón: usa el tema que el administrador haya dejado en ese
equipo. La tirilla se imprime **siempre** en blanco y negro, sin importar el tema.

## 8. Impresora de 80 mm como predeterminada

1. **Configuración de Windows → Bluetooth y dispositivos → Impresoras y escáneres**.
2. Desactiva **“Permitir que Windows administre mi impresora predeterminada”**.
3. Selecciona la impresora térmica → **Establecer como predeterminada**.
4. En **Preferencias de impresión** de esa impresora: tamaño de papel **80 mm** (rollo), márgenes en **0** y, si existe, corte automático al final.

La página de la tirilla ya pide `@page { size: 80mm auto; margin: 0 }`; si sale cortada o con márgenes, el problema suele estar en el tamaño de papel del controlador.

## 9. Roles y permisos

Los permisos viven en un solo archivo: [`src/lib/permissions.ts`](src/lib/permissions.ts). Se aplican en tres capas: `proxy.ts` (rutas), cada endpoint de la API (`guardApi`) y la barra lateral.

| | **Administrador** | **Cajero** | **Cliente** |
|---|:---:|:---:|:---:|
| Caja (vender, cobrar, imprimir) | ✅ | ✅ | ❌ |
| Cobrar con **pago electrónico (ePayco)** en la caja | ✅ | ✅ | ❌ |
| Historial de ventas `/ventas` (botones **Hoy** y **Ayer**) | ✅ todas las fechas y cajeros | ✅ solo **sus** ventas de **hoy y ayer** | ❌ |
| Ver detalle técnico del error de una venta | ✅ | ❌ | ❌ |
| Reintentar / verificar facturación | ✅ | ❌ | ❌ |
| **Pagos por revisar** (facturar, marcar para reembolso, verificar por referencia) | ✅ | ❌ | ❌ |
| Reimprimir tirilla | ✅ cualquiera | ✅ solo las suyas de hoy y ayer | ❌ |
| Productos y sincronización completa | ✅ | ❌ (la incremental corre sola desde la caja) | ❌ |
| Clientes, Usuarios, Reportes, Logs, Configuración | ✅ | ❌ | ❌ |
| Pantalla de autoservicio `/kiosco` | ❌ | ❌ | ✅ (es lo **único** que puede abrir) |

Aparte de los roles, hay páginas **públicas** (sin sesión): `/pagar/<código>` y `/pagar/<código>/respuesta` (ver sección 10).

**Accesos bloqueados:** cada vez que un usuario con sesión intenta abrir algo que su rol no permite, se guarda un log de tipo **`seguridad`** (usuario, rol, ruta y fecha). Se agrupa en **un registro por usuario, ruta y minuto**; el campo `intentos` cuenta las repeticiones. Míralos en *Admin → Logs → Tipo: seguridad*. Las peticiones sin sesión no se registran.

**Administradores:** nadie puede desactivarse ni cambiarse el rol a sí mismo, y el sistema siempre conserva al menos un administrador activo (se valida con un candado en la base de datos).

**Contraseñas:** administrador **mínimo 12 caracteres**; cajero y cliente, mínimo 8. Se valida en el servidor al crear usuarios, al restablecer contraseñas y en `npm run db:seed`.

## 10. Pagos electrónicos (ePayco / Davipay)

### Cómo se cobra

Hay dos puertas de entrada y **el mismo camino de verificación**:

| | **Caja** (cajero/admin) | **Autoservicio** (rol cliente) |
|---|---|---|
| Dónde | Modal de cobro → botón **Pago electrónico (ePayco)** | `/kiosco` |
| Número de venta | `E01-000001`… | `K01-000001`… |
| Datos del cliente | Los completa el cajero (se **autocompletan** si el cliente está en la copia de Siigo, §11e); si la cédula ya existe, se actualizan como en una venta normal | Sin autocompletar ni lectura de clientes (403); si la cédula ya existe **no se modifica** y la tirilla no muestra su nombre |
| Al aprobarse | Se factura y se abre la impresión de la tirilla | Pantalla final con el número de factura (o tirilla si `KIOSCO_IMPRESORA=true`) |

Flujo (siempre igual):

1. Primero la persona **elige cómo pagar** (§10b). El navegador **solo manda productos y cantidades**. El servidor calcula precios, IVA y total desde la base de datos, guarda la venta en **`esperando_pago`**, abre el **intento 1** y, si eligió pagar en pantalla, crea la sesión de cobro en ePayco (con QR, la crea el celular). El cobro vence a los **10 minutos**.
2. El cliente paga por **un solo canal a la vez** (ver *Canales de pago* abajo): con el **QR** en su celular (`/pagar/<código>`) o **en esta pantalla** (checkout *onpage* de ePayco). Al terminar, ePayco devuelve al navegador con `?ref_payco=…`.
3. Ese `ref_payco` es **solo una pista**: el **servidor** consulta a ePayco por su cuenta y exige: `x_cod_response = 1` (aprobada), `x_id_invoice` igual a nuestra venta, `x_amount` igual al total de la base de datos, moneda COP, `x_test_request` coherente con `EPAYCO_TEST_MODE` y firma válida (`P_CUST_ID_CLIENTE` + `P_KEY`).
4. Solo entonces la venta pasa a **`pagado`** y se factura en Siigo con el mismo flujo de siempre (sección 14). **Nunca** se marca pagada porque el navegador volvió a una página de “éxito”.
5. Cada `ref_payco` se procesa **una sola vez** (reclamo atómico en la tabla `payment_refs`).

Estados de una venta electrónica:

| Estado | Significado | ¿Se factura? |
|---|---|---|
| `esperando_pago` | Cobro creado, sin pago confirmado | No |
| `pagado` | Pago verificado por el servidor | Sí, enseguida |
| `pago_fallido` | Venció el tiempo **sin ninguna evidencia de pago**, ePayco confirmó rechazo/cancelación, el cliente canceló la compra o no se pudo crear el cobro (un rechazo o una cancelación de UN intento **no** la cierra: la venta sigue esperando y se puede reintentar) | No |
| `pago_por_revisar` | La verificación falló o algo no coincide (monto, factura, firma, formato inesperado…), **o el cobro venció con evidencia de pago sin confirmar** (`payment_status = por_confirmar`, p. ej. ePayco avisó un PSE aprobado) | **No** — decide un admin. Con `por_confirmar`, si ePayco lo confirma después (retorno del celular, consulta activa), **sí** se factura solo |
| `pago_tardio` | Se aprobó **después** de vencer el cobro | **No** — decide un admin |

Pendiente ≠ fallido: si ePayco dice “pendiente”, el cobro sigue esperando y **no se puede abrir otro intento**. “Rechazada” o “Cancelada” cierran solo ese **intento**; “Intentar de nuevo” abre otro intento de la **misma venta** (§10b).

### Canales de pago (uno a la vez)

| | Caja | Kiosco |
|---|---|---|
| Cómo se elige | **Siempre** en la pantalla *¿Cómo se va a cobrar?* (*Mostrar QR al cliente* / *Cobrar en esta pantalla*) | **Siempre** en la pantalla *¿Cómo desea pagar?* (los dos botones, del mismo tamaño) |
| Cambiar después | Desde el QR: *Cambiar forma de pago* (reemplaza el intento abierto) | Igual |

- Sin `APP_PUBLIC_URL` solo existe **en pantalla** (un celular no puede abrir `127.0.0.1`).
- El canal vive en la base de datos (`sales.pay_channel`) y lo hacen cumplir los endpoints: con QR **no** se abre el checkout en la pantalla; con "en pantalla" el enlace `/pagar/<código>` **deja de servir** y muestra *“Este cobro fue cambiado, pide uno nuevo en caja”*. Cada cambio queda en los logs (tipo `pago`).
- **Doble pago:** si aun así llegan dos pagos aprobados para la misma venta (p. ej. alguien ya estaba pagando por el canal anterior), el primero se procesa normal y el segundo **no se factura**: queda con el motivo *“Pago duplicado de la venta X, reembolsar”* en **Pagos por revisar → Pagos duplicados**.

Los reportes **no cuentan** `esperando_pago`, `pago_fallido`, `pago_por_revisar` ni `pago_tardio` en “recaudado” ni “facturado”; los pagos por revisar salen en una línea aparte con un enlace al panel.

### 10b. Pantalla de elección, intentos y consulta activa

**Pantalla de elección (kiosco y caja, el MISMO componente).** Antes de abrir nada se pregunta **«¿Cómo desea pagar?»** con dos botones grandes, táctiles y de **exactamente el mismo tamaño** (no se prioriza ninguno):
- **Pagar con mi celular (QR)** — «Escanee el código con la CÁMARA de su celular», con un recuadro de advertencia con icono: **«Escanee con la cámara del celular, NO desde la app de su banco»** (la misma advertencia se muestra junto al QR). Genera el QR de `/pagar/<código>`. Si no hay dominio público (`APP_PUBLIC_URL`), el botón queda deshabilitado.
- **Pagar en esta pantalla (tarjeta o PSE)** — «Se abrirá la ventana segura de ePayco».
- En la caja los textos son *Mostrar QR al cliente* / *Cobrar en esta pantalla*. *Volver* regresa sin perder el carrito; *Cancelar compra* siempre está a la mano.
**No se crea la venta ni la sesión de ePayco ni se abre ninguna ventana hasta que se elige un botón.**

**Intentos.** Cada vez que se elige se abre un **intento** de pago de la misma venta (tabla `payment_attempts`: número, referencia, canal, estado, fechas; nunca datos de tarjeta). Cada intento tiene su **propia referencia hacia ePayco** (`x_id_invoice`): el intento 1 usa el número de compra (`K01-000123`, como siempre) y los siguientes llevan sufijo (`K01-000123-2`, `-3`…) para no reutilizar una transacción cancelada o rechazada. El webhook y la verificación aceptan la referencia de cualquier intento y los asocian a la misma venta. Estados de un intento: `abierto`, `pendiente`, `aprobado`, `rechazado`, `cancelado`, `vencido`, `reemplazado`, `por_revisar`. Reglas que hace cumplir el **servidor** (no solo la pantalla):
- una venta **pagada, vencida o cancelada** no abre otro intento (409);
- con un intento **pendiente** (p. ej. PSE) o **aprobado** no se puede abrir otro (409), ni por cambio de canal ni con `replace`;
- con un intento **abierto** sin resultado solo se abre otro si se pide reemplazarlo (cambiar de QR a pantalla, o la ventana de ePayco nunca se abrió); el anterior queda `reemplazado`.
El historial de intentos se ve por venta (base de datos y *Admin → Pagos por revisar*).

**Evidencia de pago** (lo decide el servidor, no solo la pantalla). Un intento tiene evidencia si (a) ya se conoce su **`ref_payco`** (la mandó el navegador desde los hooks o la URL de regreso, o llegó en el webhook), (b) ePayco reportó estado **pendiente**, o (c) llegó **cualquier webhook firmado** con su referencia (`payment_attempts.webhook_at`). Reglas:
- **Con evidencia**, el servidor responde **409** (`evidencia`) a cualquier intento nuevo o cambio de canal, aunque se pida `replace`: el pago puede estar en camino.
- **Sin evidencia**, un intento abierto sí se puede reemplazar (`No, intentar de nuevo`), **salvo** que su QR ya se haya abierto en un celular.
- **QR abierto en un celular:** al abrirse `/pagar/<código>` (o crearse su sesión) se guarda `payment_attempts.qr_opened_at`. Desde entonces el servidor responde **409** (`qr_abierto`) a reemplazar ese intento: «Este pago se abrió en un celular. Termine el pago allí o cancele la compra.» (si un navegador de vista previa de enlaces abre el enlace, también cuenta: es la opción segura).
- **Inactividad del kiosco (3 min)** en «en proceso» o «¿Completó el pago?»: la venta queda en **`pago_por_revisar`** (no `pago_fallido`) y el intento **se conserva**; la consulta activa lo sigue verificando hasta que venza el cobro. Si el pago se aprueba, queda por revisar (decide un admin); si ePayco confirma que fue rechazado o cancelado y no hay otro intento vivo, la venta pasa a `pago_fallido`. En la elección o tras un rechazo/cancelación, la inactividad **cancela** la venta.
- **Nada queda abierto indefinidamente:** la tarea de fondo (cada `EPAYCO_POLL_SECONDS`) **vence** los cobros que pasaron de 10 minutos aunque nadie los consulte y **cancela** (`pago_fallido`, «cancelada») las ventas cuyo último intento fue rechazado o cancelado y nadie volvió a elegir en **5 minutos**. En la caja, al cerrar el modal con un cobro rechazado/cancelado también se cancela al instante. Con `EPAYCO_POLL_SECONDS=0` esa tarea queda apagada (los cobros solo vencen al consultarlos).
- Las ventas en `esperando_pago` (incluidas las que tuvieron un rechazo) **no** cuentan en *Total recaudado*, *Total facturado* ni en el cuadre de efectivo; `pago_por_revisar` y `pago_tardio` salen en *Admin → Pagos por revisar* y en el contador del menú.

**Pantallas tras elegir** (todas con un camino de *Cancelar compra*):
| Situación | Pantalla |
|---|---|
| La persona cierra la ventana de ePayco **sin resultado** | **«Verificando su pago con ePayco…»** con indicador de carga y *Cancelar compra* deshabilitado. **No** ofrece «Abrir el pago de nuevo» ni QR. Consulta al servidor cada 2,5 s durante máximo **15 s** |
| ePayco informa **Cancelada / Abandonada** (la persona canceló) | **«Pago cancelado»** — «Usted canceló el pago. No se hizo ningún cobro.» · *Intentar de nuevo* (vuelve a la elección, intento nuevo) · *Cancelar compra* |
| **Rechazada** por el banco / fallida | **«El pago fue rechazado»** — «Puede intentarlo de nuevo con otro medio de pago.» · *Intentar de nuevo* · *Cancelar* |
| **Con evidencia de pago en curso** tras los 15 s (típico de **PSE**) | **«Su pago está en proceso»** — «No lo repita. Estamos esperando la confirmación de su banco.» Sigue consultando mientras viva el cobro (10 min). Botones **solo** *Seguir esperando* y *Cancelar compra*; este último avisa «Si ya realizó el pago, no se perderá: quedará registrado para revisión» y deja la venta en `pago_por_revisar` (si el pago luego se aprueba **no** se marca como duplicado ni se factura sola: decide un admin con *Facturar*). No hay «Abrir el pago de nuevo» |
| **Sin ninguna evidencia** tras los 15 s | **«No recibimos confirmación de su pago. ¿Completó el pago?»** con dos botones del mismo tamaño: **«Sí, ya pagué (esperar)»** (pasa a «en proceso» y sigue consultando) y **«No, intentar de nuevo»** (vuelve a la elección y abre un intento nuevo); *Cancelar compra* sigue disponible |
| El celular **ya abrió** el QR de este intento | **«Este pago se abrió en un celular. Termine el pago allí o cancele la compra.»** — sin «Cambiar forma de pago» |
| Aprobado | Como siempre: factura, tirilla y reinicio del kiosco |
Si el pago llega después de que la persona salió, sigue el manejo de siempre (`pago_tardio` / `pago_por_revisar`). El **reinicio por inactividad del kiosco (3 minutos)** actúa en la elección y en los resultados negativos: cancela la venta abierta en el servidor y borra todo el estado de pago local; durante un pago en marcha (QR, ventana, verificando, en proceso) no reinicia.

**Cómo se sabe que la ventana se cerró.** Según la documentación de ePayco (docs.davipay.com), el hook `onClosed` del checkout *onpage* se dispara cuando el usuario **cierra o cancela** el checkout (también tras completar el pago) y `onResponse` cuando hay un resultado; la documentación **no** lista los campos que reciben (por eso se busca el `ref_payco` en cualquier parte del objeto). Como el SDK a veces no dispara los hooks, también se escuchan los mensajes (`postMessage`) de los dominios de ePayco y se detecta la **desaparición del iframe** del checkout.

**Consulta activa del servidor** (no depender solo del webhook). La documentación oficial **solo** publica la consulta por la **referencia larga** (`ref_payco`): `GET secure.epayco.co/validation/v1/reference/{ref_payco}`; **no** documenta consulta por `invoice` ni por `sessionId`. Por eso el servidor guarda en el intento la referencia larga apenas la conoce (la manda el navegador desde los hooks o la URL de regreso, o llega en el webhook) y desde entonces puede preguntar por su cuenta:
- `POST /api/kiosco/pagos/<id>/verificar` (la pantalla, cada 2,5–3 s): devuelve el estado y el último intento, y hace la consulta si ya hay referencia (máx. una cada 2 s por intento).
- **Consulta periódica en segundo plano:** cada `EPAYCO_POLL_SECONDS` (**20 s** por defecto; `0` la apaga) el servidor consulta los intentos de las ventas `esperando_pago` con cobro vigente (incluye la ruta del QR). Así un webhook retrasado no deja la venta sin facturar.
- Todo pasa por el **mismo** `processPayment` (monto, firma, invoice, modo de prueba, reclamo atómico del `ref_payco`): varias vías a la vez (webhook + pantalla + consulta activa) producen **una sola factura**.
- **Sin referencia larga no hay consulta.** Si el servidor nunca la recibe (típico de **PSE por QR**: el celular sale al banco y quizá no vuelve), el webhook firmado queda como **evidencia** y el cobro **no** termina en fallido (§10c). `EPAYCO_ALT_REF_LOOKUP=true` (apagada por defecto, experimental) prueba además consultar con `x_transaction_id` y `x_ref_payco`.

### 10c. Referencias de ePayco, URL de retorno y evidencia del webhook

**Las tres referencias (cuál es cuál):**

| Nombre | Ejemplo | Dónde llega | ¿Sirve para consultar a ePayco? |
|---|---|---|---|
| **Referencia larga** `ref_payco` | `6b048afc42f15b521510e422` (24 letras y números) | Solo por el **navegador**: `onResponse` del checkout o la URL de retorno `…?ref_payco=…` | **Sí** — es la única documentada (`GET secure.epayco.co/validation/v1/reference/{ref_payco}`) |
| Referencia corta `x_ref_payco` («Referencia Davipay») | `395055851` | Webhook, panel de Davipay | **No** (se probó el 2026-11-13: responde error) |
| `x_transaction_id` | PSE `395055851179545908`, tarjeta `103` | Webhook | **No documentado** (no se usa salvo `EPAYCO_ALT_REF_LOOKUP=true`) |

La documentación de ePayco/Davipay (docs.davipay.com → *Respuesta y confirmación*, *APIFY*) **no** publica consulta por `sessionId`, por `x_ref_payco` ni por `x_id_invoice`. En el panel de Davipay, busque la referencia larga en el detalle de la transacción.

**URL de retorno propia en cada canal.** Al crear la sesión de ePayco el POS manda su URL de respuesta:
- **QR (celular):** `https://<dominio>/pagar/<código>/retorno`. Esa página la procesa el **servidor** al cargar (no depende de JavaScript, de la pestaña ni de cuánto tarde el cliente en volver del banco): toma `ref_payco`, la **guarda en el intento** y la verifica con ePayco (`x_id_invoice`, `x_extra1`, monto, moneda, modo, firma). Muestra «Pago aprobado. Ya puede volver al kiosco/a la caja…», «Su pago está en proceso» o «El pago no se completó». La antigua `/respuesta` hace lo mismo (cobros creados antes de actualizar).
- **En pantalla:** `/kiosco` o `/caja` (o `EPAYCO_RESPONSE_URL`), como antes: la propia pantalla toma `ref_payco` y lo manda al servidor.

**El webhook firmado cuenta como evidencia y frena el vencimiento.** Cada aviso firmado guarda en el intento un **resumen** (`payment_attempts.webhook_summary`: `x_ref_payco`, `x_transaction_id`, `x_id_invoice`, `x_extra1`, monto, moneda, estado, franquicia, `x_test_request`, fechas; **sin** firma ni datos personales). Con `x_cod_response=1` se marca `webhook_approved_at`. Reglas:
- Un intento con aviso **aprobado** (o con referencia larga, o pendiente) **nunca** pasa a `vencido` ni la venta a `pago_fallido`: al vencer el cobro pasa a **`pago_por_revisar`** con `payment_status = por_confirmar` y el motivo *«ePayco avisó un pago aprobado que no se pudo confirmar automáticamente»*. La consulta activa lo sigue intentando (hasta 24 h, como mucho cada minuto) y, si llega la referencia larga, se **factura sola**.
- `pago_fallido` solo **sin ninguna evidencia** o con rechazo/cancelación confirmados (un aviso firmado de rechazo no es evidencia de pago).
- Una venta ya fallida/vencida que **después** recibe un aviso aprobado pasa a **`pago_tardio`** (decide un admin).
- Kiosco y caja muestran **«Su pago está en proceso»** (sin contador) mientras haya evidencia; nunca «rechazado» ni «¿Completó el pago?». Con QR, el kiosco dice *«Termine el pago en su celular; si pagó por PSE puede tardar unos minutos»*. En cuanto se confirma, avanza sola a la factura.
- Con un aviso recibido, el celular ya no ofrece «Pagar ahora» y el servidor no deja abrir otro cobro desde el enlace (409).

**Facturar sin consultar a ePayco (último recurso).** Mismas condiciones en los dos casos (`src/lib/epayco/trust.ts`): aviso con **firma válida**, `x_cod_response=1`, `x_cod_transaction_state=1`, `x_amount` = total **guardado en la base**, `x_currency_code=COP`, `x_id_invoice` = referencia del **intento vigente**, `x_extra1` = UUID de la venta y `x_test_request` coherente con `EPAYCO_TEST_MODE`.
- **Botón del admin «Facturar con evidencia del webhook»** (*Pagos por revisar*): pide confirmación y **nota obligatoria**; registra quién y cuándo (`payment_attempts.evidence_*` y log). Una sola factura aunque se pulse dos veces o coincida con el webhook o la consulta activa (409 al segundo).
- **Automático:** `EPAYCO_TRUST_SIGNED_WEBHOOK=true` (**apagada por defecto**). ⚠ Riesgo: la firma **no** cubre el estado, el invoice, `x_extra1` ni `x_test_request`, y nadie le pregunta a ePayco; quien tenga la `P_KEY` podría fabricar un aviso. Por eso se exigen todas las condiciones contra la base de datos. Encenderla solo si la consulta por referencia larga no es viable y aceptando ese riesgo.

### Pagos por revisar (`/admin/pagos-por-revisar`, solo admin)

- **Pendientes de decisión:** muestra fecha, venta, cliente, monto, motivo, `ref_payco` y de dónde vino (caja o autoservicio).
  - **Facturar** (pide confirmación): el admin confirma que el dinero **sí entró** en el panel de ePayco; la venta pasa a `pagado` y se factura.
  - **Marcar para reembolso** (pide confirmación): solo deja constancia (fecha y quién). **El reembolso real se hace en el panel de ePayco.** La venta no se factura y queda fuera de todos los reportes.
- **Cobros sin confirmar (últimos 7 días):** por si el cliente **sí pagó** pero el sistema no recibió la referencia larga. **Verificar con referencia** acepta la **referencia larga** o un **enlace con `ref_payco=`** (también está en *Pendientes de decisión* para las ventas por revisar). Si pega el número corto o el `x_transaction_id`, responde al instante que ese dato no sirve y cuál se necesita. Mensajes: *Pago aprobado y verificado*, *ePayco no respondió (se esperó 10 segundos)*, *ePayco respondió con un error (HTTP n)*, *ePayco no encontró esa referencia*, *El monto no coincide…*, *Estado: pendiente / rechazado / cancelado*. Cada verificación queda en el log (tipo de referencia, HTTP, tiempo, resultado; sin la referencia ni datos personales). Toda llamada a ePayco se corta a los **10 s**.
- **Facturar con evidencia del webhook:** solo en ventas con un aviso firmado de pago **aprobado** sin confirmar (§10c).
- **Pagos duplicados:** segundos pagos aprobados de una venta que ya estaba pagada. Nunca se facturan ni cuentan como recaudado. **Marcar para reembolso** deja constancia; el reembolso se hace en ePayco.
- **Marcadas para reembolso:** historial de constancias.

> La referencia que sirve para consultar a ePayco es la **larga** (24 caracteres hexadecimales, la que viene en `?ref_payco=`). El número corto “Referencia Davipay” (p. ej. `393429259`) y el `x_transaction_id` **no** sirven para verificar (§10c).

### Páginas públicas de pago (siempre activas)

- **`/pagar/<código>`** — el cliente paga **esa** compra desde su celular. El `<código>` son 48 caracteres aleatorios (`pay_token`) imposibles de adivinar; la página solo muestra el número de compra, el total y el estado.
- **`/pagar/<código>/retorno`** (y la antigua `/respuesta`) — a donde ePayco devuelve al cliente al terminar. Llegar aquí **no** significa que pagó: el **servidor** guarda y verifica la referencia larga y la página muestra el estado real (§10c).
- Sus endpoints (`/api/pagar/<código>…`) no exigen sesión, limitan los intentos por código, verifican **siempre** con ePayco y nunca devuelven datos del cliente ni detalles técnicos. No aparecen en buscadores (`noindex`).
- El **QR** con el enlace sale **solo con el canal QR activo** y **solo si `APP_PUBLIC_URL` está definido** (un celular no puede abrir `127.0.0.1` del equipo de la caja). Si el cobro se pasó a "en pantalla", el enlace muestra *“Este cobro fue cambiado, pide uno nuevo en caja”*.

### Webhook de confirmación

`/api/epayco/confirmacion` está **apagado (404) mientras `APP_PUBLIC_URL` esté vacío**: ePayco no puede llamar a `127.0.0.1`. Con dominio público:

1. Define `APP_PUBLIC_URL=https://tu-dominio` (con HTTPS) y reinicia.
2. El cobro se crea con la URL del webhook. ePayco avisa **sin depender del navegador**: exige `x_signature` válida, ubica la venta por `x_id_invoice` y **vuelve a consultar** a ePayco (no confía en el contenido del aviso). Es idempotente: ePayco puede reintentar.

**Referencia corta y larga (importante, §10c).** El webhook trae `x_ref_payco` (corta) y `x_transaction_id`, **nunca** la larga. Por eso:
- Exige `x_signature` válida; ubica la venta por `x_id_invoice` y, si viene `x_extra1` y **no** es el UUID de esa venta, **no lo procesa** y lo registra (nivel error).
- Guarda en el intento el resumen del aviso (evidencia). Si el servidor ya conoce la referencia larga (la trajo el navegador), **consulta** a ePayco y confirma como siempre.
- Si no la conoce, **no decide nada**: queda como evidencia (y frena el vencimiento si dice aprobado); la confirmación llega por el retorno del celular, la consulta activa o el admin. Con `EPAYCO_TRUST_SIGNED_WEBHOOK=true` (apagada por defecto) se aprobaría solo con el aviso, con todas las condiciones de §10c.
- Si la consulta **no se pudo resolver** (ePayco caído, error de red), la venta sigue esperando y el webhook responde 500 para que ePayco reintente. Lo que **sí llega y no coincide** (monto, factura, `x_extra1`, modo de prueba, código distinto de 1, firma) va a "por revisar".
- El mismo pago visto con las dos referencias es **un solo pago**, no un duplicado. Un pago es duplicado solo si es **otra transacción**; aun así, antes de reembolsar confirme en el panel de ePayco.

Sin el webhook (modo local), la confirmación depende de que el navegador vuelva con el `ref_payco`; si no vuelve, el admin usa **Cobros sin confirmar** (arriba).

### Tarjeta de prueba

Con `EPAYCO_TEST_MODE=true` los pagos no cobran dinero real. Visa aprobada: **`4575 6231 8229 0326`**, cualquier fecha futura, CVV `123`. Para forzar rechazada o pendiente consulta la lista actual en la documentación de ePayco (docs.epayco.com).

## 11. Autoservicio (kiosco)

Pantalla táctil para el rol **Cliente**: búsqueda por nombre/SKU, lector de código de barras, carrito propio, **consulta del cliente por su cédula con datos enmascarados** (§11f) y **solo pago electrónico**.

- **Bloqueo:** sin barra lateral ni enlaces, atajos de teclado y menú contextual bloqueados, botón “atrás” inactivo. El rol `cliente` solo puede abrir `/kiosco` (y los endpoints del kiosco).
- **Reinicio automático:** al terminar una venta y tras 3 minutos sin actividad vacía el carrito y vuelve al inicio.
- **Sin conexión:** se deshabilita con el mensaje “Autoservicio no disponible, acérquese a la caja”.
- **Salida:** `Ctrl + Alt + Shift + K` (o 7 toques rápidos sobre el logo) abre un diálogo que pide **correo y contraseña de un administrador**. Hay límite de intentos (5 fallos por 10 minutos) y cada intento queda en los logs. No existe un PIN compartido.
- **Impresora:** `KIOSCO_IMPRESORA=false` → pantalla final con el número de factura; `true` → imprime la tirilla al aprobarse. El envío de la factura por correo con Siigo **todavía no está activado**.
- **Pantalla completa:** el acceso directo de Chrome de la sección 7 abre el kiosco ya en pantalla completa. Si se abre de otra forma,
  la pantalla muestra **“Toque para iniciar”**: el primer toque del cliente activa la pantalla completa y entra al catálogo
  (el navegador no deja hacerlo sin un gesto del usuario). También hay un botón de pantalla completa en el encabezado.
- **Tema:** el kiosco no tiene botón de modo oscuro; usa el que el administrador haya dejado en ese equipo.
- **Equipo del kiosco:** usa una cuenta de Windows restringida y el acceso directo de la **sección 7**.

## 11b. Comprobantes de pago (foto con la cámara web)

Evidencia para auditoría. **No reemplaza** la referencia ni la casilla *“Verifiqué el pago en el datáfono o en la cuenta de FECP”*.

| Medio | Comprobante |
|---|---|
| Transferencia (Nequi/Bancolombia/otra) | **Obligatorio**: no se puede confirmar la venta sin la foto |
| Tarjeta (datáfono; y las históricas débito/crédito) | Opcional |
| Efectivo, Crédito FECP, ePayco | No aplica |

Con **varios medios** (cobro dividido): si hay **una línea de Transferencia**, la foto es obligatoria (una por venta); si solo hay Tarjeta, es opcional.

- **Captura:** en el modal de cobro, **Tomar foto del comprobante** abre la cámara (vista previa → *Capturar* → *Repetir* / *Usar esta foto*) y muestra la miniatura. Si no hay cámara o Chrome la bloquea, ofrece **Subir imagen desde el equipo** y explica cómo permitir la cámara (candado junto a la dirección → *Cámara* → *Permitir*). La cámara exige **https** (o `127.0.0.1`).
- **Sin conexión:** la foto se guarda con la venta en el equipo (**IndexedDB**) y se sube sola cuando vuelve la conexión, **después** de que la venta exista en el servidor. Mientras no llegue, la transferencia queda **“Comprobante pendiente”**.
- **Guardado:** fuera de `public/` (en Docker, volumen `fecp_pos_uploads`; en desarrollo, `uploads/comprobantes`), con nombre aleatorio (UUID). El servidor valida el tipo **por el contenido** (JPG, PNG o WebP), máximo **10 MB**, una imagen por venta (**solo un admin** la reemplaza), y la recomprime con `sharp`: máx. 1600 px por lado, JPEG ~75, **sin metadatos** (EXIF, GPS…).
- **Historial (`/ventas`):** botón **Ver comprobante** en cada venta que lo tenga → visor grande con fecha, medio, referencia, quién lo subió y **Descargar** (`comprobante-C01-000123-2026-11-12.jpg`). Filtros: *Con comprobante*, *Sin comprobante*, *Comprobante pendiente*. Las transferencias sin foto se resaltan en amarillo. Desde ahí también se puede **Adjuntar comprobante** a ventas viejas o pendientes.
- **Permisos:** admin, todos; cajero, solo los de sus ventas de **hoy y ayer** (la misma regla de reimprimir); rol cliente, nunca. Se sirven por un endpoint autenticado (`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`) y **cada vista o descarga queda en los logs**.
- **Retención:** una tarea diaria dentro de la app borra los archivos con más de `RECEIPT_RETENTION_DAYS` (**180**) días desde la fecha de la venta; el registro queda como *“Eliminado por retención el <fecha>”*. Los respaldos (ver DEPLOY.md) también incluyen las fotos.

## 11c. Medios de pago y cobro dividido

**Medios** (ids internos en `sale_payments.method`): **Efectivo**, **Tarjeta** (reemplaza a *Tarjeta débito* y *Tarjeta crédito*), **Transferencia**, **Crédito FECP** y **Pago electrónico** (ePayco: PSE, tarjetas, QR). Las ventas históricas conservan su etiqueta original (*Tarjeta débito*, *Tarjeta crédito*): la migración no reescribe nada.

**Reglas del cobro dividido** (se validan en el **servidor**, con el total que él calcula de los productos, y se repiten en la pantalla):
1. Una venta tiene **1 a 4 líneas** de pago, **una por medio**.
2. La suma de los montos aplicados es **exactamente** el total.
3. **Efectivo** es el único que recibe más de lo aplicado: `cash_received` y `change_given` solo en esa línea. Los demás llevan el monto exacto y no pueden superar lo que falta por cubrir.
4. **Tarjeta** y **Transferencia** exigen referencia por línea (y la casilla *“Verifiqué el pago…”*).
5. **Pago electrónico** solo puede ser el **único** medio, por el total, y se cobra por su propio flujo (el kiosco no cambia).
6. **Crédito FECP**: exige cliente identificado con **cédula o NIT real** (no Consumidor final ni pasaporte), **datos completos** (aunque la venta sea < 5 UVT) y el plazo **único de 60 días** (`CREDITO_PLAZO_DIAS`; la caja no deja elegir otro y el servidor rechaza cualquier otro); guarda `due_date` = fecha de la venta + plazo. **No hay cupo ni abonos:** el POS no lleva saldos, eso queda en Siigo.

**En la caja:** el modal muestra siempre **“Falta por cubrir: $X”** y solo deja confirmar cuando es **0**. Empieza con una línea de efectivo que cubre el total; **“Dividir el pago”** agrega medios, y la línea automática se completa sola con lo que falta (el efectivo trae botones de billetes, *Exacto* y el cambio en grande).

**Base de datos:** `sale_payments` (una fila por línea). Las columnas viejas de `sales` se conservan: `payment_method` vale el medio de la única línea o **`mixto`**; `payment_reference` junta las referencias (`4821 / NEQ-9`); `cash_received`/`change_given` son los de la línea de efectivo. **Reportes, cuadre e historial se calculan desde `sale_payments`.** `npm run db:setup` crea la tabla y **migra** cada venta existente a una línea (idempotente; no toca las columnas viejas).

**Siigo:** se envía **un pago por línea** con el id de `src/config/siigo-map.ts` (Efectivo 1666 · Tarjeta 1669 · Transferencia 5798 *(valor de pruebas, por confirmar)* · Pago electrónico `EPAYCO_SIIGO_PAYMENT_ID` · Crédito `SIIGO_PAYMENT_CREDITO_ID`). La línea de crédito lleva `due_date`. **Antes de enviar** el POS verifica que la suma de los pagos sea igual al total de la factura; si no, no se envía nada y la venta queda en **revisión** con el motivo. `observations` lista cada medio: `POS FECP venta {UUID} | Tarjeta 40000 ref 4821 | Credito FECP 30400 30d | Efectivo 50000`.

> Lo que Siigo **sí documenta**: `payments` es una lista de `{id, value, due_date}`; `due_date` (yyyy-MM-dd) solo es obligatorio si la forma de pago tiene `due_date=true`, y solo se admite **una** con vencimiento por factura. Lo que **no documenta** (y por eso el POS lo exige por su cuenta): si la suma de pagos debe igualar el total. Verificado en la práctica (modo prueba, comprobante 6503): Siigo acepta varios pagos en la misma factura.

**Tirilla:** lista cada línea con su monto y referencia, el cambio solo en la de efectivo y, si hay crédito, el plazo y el vencimiento. **`/ventas`:** muestra *Mixto* con el detalle desplegable. **Reportes:** *Total recaudado* cuenta solo lo cobrado (efectivo, tarjeta, transferencia, electrónico); **el crédito NO es dinero recaudado** y sale aparte en *Ventas a crédito* (por cliente, plazo y vencimiento). Los totales por medio salen de `sale_payments`. El **cuadre de efectivo** suma solo el efectivo **aplicado**, no el billete entregado.

**Sin conexión:** la venta dividida viaja en la cola local con el formato nuevo (`payments`); las ventas que ya estaban en la cola con el formato viejo (`payment_method`, `cash_received`) se siguen enviando sin error.

**Numeración:** el número impreso sale del **prefijo y consecutivo que devuelve Siigo** (no hay ningún "FVP" ni "FE" escrito en el código); el comprobante lo define `SIIGO_DOCUMENT_ID` (FECP: `35123`). Los datos de resolución de la tirilla salen de `RESOLUCION_DIAN_*`.

## 11d. Validación de precios en la caja

La caja arma la venta con el catálogo guardado en el equipo (así funciona **sin conexión**) y manda precio, IVA y SKU. El servidor **ya no se fía**: al recibir cada venta de `/api/sales` (todos los medios, incluidos el pago dividido y el crédito) compara **cada línea** con la tabla `products`.

- **El kiosco y el cobro electrónico no tienen este problema:** solo mandan `product_id` y cantidad; precio, IVA y total salen de `products` (regresión: `node --env-file=.env.local db/prueba-kiosco-precio.mjs`).
- **Regla (tolerancia cero):** una línea es válida si su precio, IVA (`tax_rate` y `prices_include_tax`) y SKU coinciden con los **vigentes**, o con alguno que estuvo vigente en las últimas `PRICE_HISTORY_HOURS` horas (**72** por defecto). Así una venta hecha sin conexión con un precio que luego cambió no genera falsas alarmas. El historial (`product_price_history`) lo llena un **disparador** sobre `products`: cualquier cambio de precio, IVA o sku (sincronización completa, incremental o la de IVA con Siigo) queda registrado. `db:setup` crea la línea base con los valores actuales.
- **Si algo no coincide la venta NO se rechaza** (el cliente ya pagó): se **acepta y se guarda**, queda `pending` con el motivo en `last_error` y **no se factura sola** (ni se reintenta, ni desde el botón *Reintentar* de `/ventas`). Lo mismo si el producto no existe ("producto desconocido"). Solo se rechazan datos estructuralmente inválidos (cantidad cero o negativa, pagos que no cuadran).
- **Hora del equipo:** `created_at_device` se acepta entre *hace 7 días* y *ahora + 5 minutos*; fuera de eso se usa la hora del servidor y se anota (`sales.time_note` y logs).
- **Panel `/admin/precios-por-revisar` (solo admin):** venta, cajero, hora, cuánto lleva retenida y las líneas con *enviado / vigente / diferencia*. **Aprobar y facturar** (con confirmación; para cambios legítimos como una promoción; usa el flujo de facturación con idempotencia: una sola factura aunque se pulse dos veces) o **Anular** (exige una nota; nunca se factura). No hay "corregir al precio de la base": el cliente ya pagó el monto original. Cada decisión queda atada a su admin, con fecha y nota, y en los logs.
- **Avisos:** contador en el menú de admin y en Reportes; a las **2 h** retenida se marca *atrasada* y a las **4 h** en *rojo*. **Configuración** muestra la ventana y cuántas hay por revisar.
- **Cuadre:** las ventas anuladas con dinero cobrado salen en **Reportes → Ventas anuladas con dinero cobrado** (monto y nota) y en el cuadre de efectivo ("Efectivo total esperado en caja"); no cuentan en *Total recaudado* ni *Total facturado*.

## 11e. Clientes de Siigo en el POS

Los clientes se copian **de Siigo al POS, en una sola dirección** (Siigo manda; el POS nunca crea ni modifica nada en Siigo con esta función: solo `GET /v1/customers`).

- **Qué se trae:** solo los terceros de tipo **cliente** (el filtro `type=Customer` de Siigo; ya excluye las sucursales, se usa la principal). Proveedores y "otros" no. Por cliente se guarda solo lo necesario para facturar: tipo y número de documento, dígito de verificación, nombre o razón social, correo, teléfono, dirección, departamento y ciudad, y el **id de Siigo** (`customers.siigo_id`). Los inactivos se guardan marcados (`active = false`) y **no se ofrecen en la caja**.
- **Reglas de "Siigo manda":** upsert por identificación, idempotente (una segunda corrida no toca ninguna fila). Si Siigo trae un valor, reemplaza al del POS; si Siigo **no** trae correo, teléfono, dirección o ubicación, se conserva el que el POS ya tenía. **No se toca** el *Consumidor final* `222222222222`. Si una identificación viene repetida en Siigo se conserva la primera y se cuenta en el log. Se **omiten** (y se cuentan por motivo) los terceros sin tipo de documento, sin nombre o con un número de documento que el POS no acepta.
- **Botón:** **Admin → Clientes → Sincronizar clientes** (solo admin). La primera vez trae todo; las siguientes piden solo lo **modificado** (`updated_start`) y lo **creado** (`created_start`) desde la última corrida **con un día de traslape** (hay que pedir ambos: Siigo no pone fecha de modificación a los nuevos). *Recarga completa* vuelve a pedir todo.
- **Cómo corre:** en segundo plano dentro de la app, por páginas de 100 (nunca todo en memoria), con barra de progreso. **Una sola a la vez**, con bloqueo en la base (si hay otra, el botón responde 409 con "ya hay una sincronización en curso"). Si el servidor se reinicia o Siigo falla a mitad, la corrida queda *interrumpida* y **se retoma** desde la última página guardada con el botón *Retomar*. Muestra el total en el POS, la fecha de la última sincronización, un historial y los errores.
- **Historial:** cada corrida guarda sus conteos y, de los clientes que cambiaron, **qué columnas** cambiaron (por ejemplo "correo 3, dirección 1"; solo conteos, nunca los valores).
- **Limitación conocida:** la sincronización incremental depende de la fecha de modificación (`last_updated`) que Siigo pone a cada tercero. Si Siigo no la actualiza en algún cambio, ese cambio no llega hasta la próxima **Recarga completa** (≈ 4,5 min): conviene hacerla de vez en cuando (por ejemplo, una vez por semana).
- **Ritmo:** máximo **40 peticiones por minuto** (~17.000 clientes ≈ 170 páginas ≈ **4,5 minutos**), con espera y reintento ante 429 o errores temporales de Siigo. Comparte la ventana de peticiones del cliente de Siigo con la facturación y **cede el paso**: si ya van más de 60 en el último minuto, espera.
- **Caja:** el cliente se busca por su **número de documento completo** en el primer paso del cobro (§11f). Se consulta primero esta tabla y, si no está, se hace UN intento en vivo a Siigo (GET por `identification`, 4 s, solo lectura; si falla se trata como "no encontrado"). El Crédito FECP funciona con estos clientes (exige cédula o NIT real, igual que antes).
- **Kiosco:** el rol *cliente* **no puede leer ni buscar** nada de `customers` (`/api/customers` y `/api/admin/clientes/*` responden 403). Solo tiene su propia consulta por cédula, que devuelve **datos ya enmascarados** (`POST /api/kiosco/cliente`, §11f). La tirilla del kiosco solo muestra `***` + 3 últimos dígitos del documento, nunca el nombre guardado.
- **Logs** (tipo `sync`): inicio y fin de cada corrida con conteos (creados, actualizados, sin cambios, omitidos, repetidos, errores), y cada búsqueda en vivo con el documento enmascarado (`***123`). Nunca nombres, documentos completos ni correos.
- **Tipos de documento:** la tabla acepta cualquier código de 2 dígitos de la DIAN que traiga Siigo (cédula, NIT, tarjeta de identidad, documento extranjero…). Los formularios de la caja y del kiosco siguen ofreciendo los 4 de siempre para clientes **nuevos**.

## 11f. Checkout: la cédula va PRIMERO

El monto **ya no decide** el tipo de checkout. Siempre se identifica al cliente primero (o se elige Consumidor final). Según el art. 11, num. 3.3 de la Res. DIAN 165/2023 se puede facturar a Consumidor final (`222222222222`) sin importar el monto si el cliente no da sus datos; como el contador aún debe confirmar el efecto de la Res. 227/2025, hay una bandera:

- **`CONSUMIDOR_FINAL_SIN_TOPE`** (`.env.local` / `.env.production`): `true` (por defecto si falta) = Consumidor final sin tope. `false` = se conserva el comportamiento anterior: con la base sin IVA por encima de **5 UVT** hay que identificar al cliente (la caja deshabilita "Consumidor final" con una explicación; el kiosco no lo ofrece y el servidor del kiosco lo rechaza). En la caja el servidor no rechaza una venta ya cobrada (puede venir de la cola sin conexión): solo deja una advertencia en los logs. **Admin → Configuración** muestra el valor activo. Cambiarlo no requiere tocar el código: edita el archivo y reinicia.

**Caja (cajero y administrador)** — *Cobrar* abre el cobro en **dos pasos**:
1. **Cliente.** Tipo de documento (Cédula de ciudadanía por defecto, NIT y los demás del sistema) y número; **Enter = Buscar**. Debajo, **Consumidor final** (salta la búsqueda) y **Factura a nombre del cliente (F9)** (abre directo el formulario, sin buscar). El servidor busca en `customers` y, si no está, hace un intento en vivo a Siigo.
   - **Existe:** se ve el nombre completo, el tipo y número de documento; el **correo y el teléfono van ofuscados** (`d***@gmail.com`, `300***1234`: el navegador nunca recibe los reales). **Facturar a este cliente** pasa al pago. Si le faltan datos obligatorios (nombres/razón social, DV, correo, dirección, departamento, ciudad) **se piden solo los que faltan**; los demás no se tocan.
   - **No existe:** dos botones grandes, **Consumidor final** y **Factura electrónica a nombre del cliente** (formulario completo en blanco; el cliente se crea en Siigo al facturar).
2. **Pago.** Igual que antes (pago dividido, referencias, foto del comprobante, ePayco). **Crédito FECP** exige un cliente identificado con cédula o NIT y datos completos: si el cliente actual es Consumidor final, el cobro vuelve al paso 1 con un mensaje.
- **Sin conexión:** la búsqueda necesita el servidor, así que se deshabilita con un aviso; siguen disponibles Consumidor final y el formulario manual, y la venta se encola como siempre. No hay copia local de clientes en el navegador.
- **Nunca se sobrescribe un cliente guardado:** el navegador solo manda el tipo y el número de un cliente que ya existe (más los datos que le faltaban); el **servidor** completa únicamente esos campos vacíos y lo guardado no cambia. Tampoco se modifica nada en Siigo. La búsqueda parcial por prefijo o nombre ya no existe en la caja (se identifica por documento completo, y así el correo y el teléfono no se exponen).
- **Tirilla/factura:** el tipo de documento sale en su propia línea, antes del número ("Cédula de ciudadanía" y debajo el número).
- **Logs:** cada venta registra la rama usada (`consumidor_final`, `cliente_existente` o `cliente_nuevo`), sin datos personales.

**Kiosco (rol cliente)** — nuevo paso **"Ingrese su número de cédula"** (teclado numérico grande), antes de los datos de contacto:
- Hay que escribir el **número completo** y tocar **Consultar**: no hay búsqueda parcial ni autocompletado mientras escribe.
- `POST /api/kiosco/cliente` (solo rol cliente) responde **solo datos enmascarados**: nombre con 3 letras + 4 asteriscos por palabra (`DAN**** MUN**** ROD****`, siempre del mismo largo: no revela el largo real) y cédula con 4 dígitos + 4 asteriscos (`1018****`). Nunca correo ni teléfono. Todo lo demás (no existe, inactivo, formato inválido, Siigo no responde) responde exactamente `{"found":false}` y tarda lo mismo (mínimo 1,2 s). **Límite: 10 consultas cada 10 minutos por IP y por sesión** (429); se cambia en las constantes `KIOSK_LOOKUP_MAX` y `KIOSK_LOOKUP_WINDOW_MS` de `src/app/api/kiosco/cliente/route.ts`. En los logs solo se guardan los últimos 3 dígitos.
- **Existe:** "¿Es usted?" con la máscara, aviso de protección de datos (Ley 1581 de 2012) y **Sí, soy yo / No, corregir**. Al confirmar, el navegador manda **solo el número**; el servidor vuelve a buscar al cliente (nunca recibe nombre ni id de Siigo, y lo que mande se ignora). El correo y el teléfono del paso de contacto **no se prellenan**.
- **No existe:** **Consumidor final** o **Factura electrónica a mi nombre** (formulario en blanco, sin autocompletar). También hay un enlace "No quiero dar mi cédula (Consumidor final)" en el primer paso.
- Todo el estado de la consulta vive en la pantalla: al volver atrás, al terminar la compra o por inactividad (3 minutos) se borra.

## 11g. Catálogo unificado WooCommerce + Siigo y bodega por usuario

### Qué hace
- **Un solo catálogo** (tabla `products`) con los productos de WooCommerce **y** los de Siigo (todas las bodegas), sin duplicados. La llave de unión es el **código de Siigo = SKU de WooCommerce**, sin espacios y en MAYÚSCULAS. Si un código está repetido (en Siigo o en WooCommerce) **no se une**: se marca (`siigo_ambiguous`) y se reporta en el resumen de la sincronización.
- `products.origin`: `woocommerce` (solo Woo) · `siigo` (solo Siigo, sin `woo_id`) · `ambos` (unidos). Columnas nuevas: `siigo_id`, `siigo_code` (el código **tal como está en Siigo**: es el que va en la factura), `siigo_type`, `siigo_active`, `siigo_group`, `siigo_name`, `siigo_price`, `siigo_price_includes_tax`, `siigo_synced_at`, `woo_seen_at`. Tablas nuevas: `warehouses` (bodegas), `product_stock` (existencias por producto y bodega), `user_warehouse_log` (historial de la bodega de cada usuario) y `product_sync_runs` (corridas de la sincronización). `users.warehouse_id`, `users.session_warehouse_id`, `sales.warehouse_id` y `sales.warehouse_name`.
- **Producto en ambos:** nombre, imagen, categoría, precio e IVA **siguen siendo los de WooCommerce**. De Siigo solo se agregan `siigo_*` y las existencias. Si el precio o el IVA difieren **no se cambian**: el resumen de la sincronización los cuenta («55 con IVA distinto, 5 con precio distinto» en los datos reales) y el detalle del IVA sigue en `npm run report:iva`.
- **Producto solo en Siigo:** nombre, código, precio, IVA y existencias salen de Siigo. Categoría = grupo de inventario de Siigo. **Siigo no tiene imágenes**: en la caja, el kiosco y Admin → Productos se muestra un marcador neutro con las iniciales (mismo tamaño que las fotos, claro y oscuro).
- **No entran al catálogo vendible:** los inactivos en Siigo y los tipos que no sean producto (servicios, etc.; el admin lo cambia en *Configuración → Tipos de producto de Siigo*), ni los productos sin precio o con IVA que no sea 0/5/19 %.
- **Quién manda:** la sincronización de WooCommerce (completa, incremental y la de IVA) **nunca** borra, desactiva ni cambia un producto solo-Siigo; la de Siigo **nunca** pisa nombre, imagen, categoría, precio ni IVA de un producto de WooCommerce. Si un producto unido deja WooCommerce pasa a ser solo de Siigo (con los datos de Siigo); si aparece en WooCommerce uno con el código de un solo-Siigo, **se une a esa fila** (no se duplica) y quedan los datos de WooCommerce.

### Precio e IVA de Siigo (verificado con la API real el 2026-11-24)
- `GET /v1/products` trae `prices[].price_list[]` con **listas por NOMBRE** (el orden cambia de un producto a otro). Para los productos solo-Siigo se usa la lista **«Precio de venta 2»** (configurable) y, si el producto no la tiene, «Precio de venta 1». Motivo: en los 703 productos que están en las dos partes, el precio de WooCommerce **coincide con «Precio de venta 2» en 684 (97 %)** y con «Precio de venta 1» solo en 17 (los que solo tienen lista 1); la lista 1 es ~10 % más cara.
- `tax_included` dice si el precio **incluye** IVA (`true` en los gravados al 19 %, `false` en exentos y excluidos); el POS lo guarda en `prices_include_tax`. `tax_classification` = Taxed / Exempt / Excluded; los gravados traen el impuesto `IVA 19%` (id 2785) y los exentos `IVA 0%` (id 26387).

### Sincronización de Siigo (Admin → Productos)
- Botón **Sincronizar productos de Siigo** (junto al de WooCommerce) y **Solo existencias**. Corre en segundo plano con barra de progreso y, al final, el resumen: creados, actualizados, unidos con WooCommerce, omitidos (inactivos, servicios u otros tipos, sin precio), ambiguos, con error, desactivados, bodegas y existencias.
- Solo lee (`GET /v1/products`, `GET /v1/warehouses`): páginas de 100, **máximo 80 peticiones por minuto**, cede el paso a la facturación (espera si ya van más de 70 en el último minuto), reintenta 4 veces con espera creciente y respeta el 429 de Siigo. **Primera sincronización real: 61 segundos** (33 páginas, 3.281 productos, 52 bodegas con existencias, 15.299 registros).
- **Un solo candado** para toda sincronización de productos (WooCommerce completa/incremental y Siigo completa/existencias): si hay otra en curso responde 409 («Ya hay una sincronización de productos en curso»). La incremental de la caja simplemente se salta ese turno.
- **Automática** (después de la primera completa manual): una vez al día entre las 2:00 y las 5:59 (hora de Colombia) catálogo completo + existencias, y las **existencias de todas las bodegas cada 30 minutos** (Admin → Configuración; 5 a 1440 min; 0 = apagado). Si Siigo falla se reintenta como mucho cada hora (la diaria) o en el siguiente turno (existencias). La API no ofrece filtro por bodega, así que cada actualización de existencias lee el catálogo completo (33 peticiones).
- Solo admin. Logs de tipo `sync` con conteos y sin datos sensibles. Una venta **nunca** se bloquea por inventario (las existencias son informativas); Admin → Productos muestra las existencias de la bodega elegida.

### Bodega de Siigo por usuario
- **Admin → Usuarios:** selector «Bodega de Siigo» (lista en vivo de `GET /v1/warehouses` con caché de 5 min y botón «Actualizar bodegas»; si Siigo no responde se usa la última lista guardada y se avisa). **Admin → Configuración:** bodega por defecto para los usuarios sin asignar, frecuencia de existencias, lista de precios, tipos de producto y, por bodega, si su catálogo incluye también los productos de WooCommerce (por defecto sí).
- **Kiosco:** bodega fija del usuario; el cliente no la ve ni la cambia, y el servidor solo vende lo que el catálogo de esa bodega muestra. **Cajero:** usa su bodega y no puede cambiarla (lo impide el servidor: una venta con otra bodega responde 400 y queda en logs de seguridad). **Admin:** usa la suya (o la de por defecto) y puede cambiarla **solo para su sesión de caja** con «Vendiendo desde: …» (se bloquea con el carrito lleno); queda en el log quién cambió y a cuál, y al volver a iniciar sesión se descarta.
- **Catálogo por bodega:** productos con registro en la bodega del usuario (aunque la cantidad sea 0) + los de WooCommerce si la bodega lo permite. Sin bodega: solo los de WooCommerce.
- **La venta guarda la bodega** (`sales.warehouse_id`/`warehouse_name`) al cobrar, también en la cola sin conexión. El servidor la valida contra el usuario: acepta la actual o la que el usuario tenía cuando se hizo la venta (historial ±5 min), así una venta hecha sin conexión en la bodega A y enviada después de reasignar al usuario a B **factura en A**. Los reintentos facturan con la bodega guardada.

### Factura
- Cada ítem lleva `warehouse` = bodega de la venta (**confirmado con la API real**: la factura de prueba devolvió `items[].warehouse = {id: 764, name: …}`; la documentación dice que el campo es opcional, que debe existir y estar activo). Sin bodega no se manda el campo.
- Los ítems se facturan con el **código de Siigo** del producto (`siigo_code`; si no hay, el SKU de siempre).
- Un producto de WooCommerce que **no existe en Siigo** (después de una sincronización completa de Siigo) o que está **inactivo** en Siigo **no se factura**: la venta queda en «Fallida» con el motivo claro («no existe en Siigo…», «inactivo en Siigo…») y se reintenta desde Ventas cuando se corrija. Antes de la primera sincronización de Siigo todo funciona como siempre.
- Observaciones de la factura: `POS FECP venta <UUID> | Bodega <nombre, máx. 40 caracteres> | <pagos>`. La tirilla muestra la bodega. Reportes: filtro y tabla «Por bodega de Siigo».

### Caja sin conexión y rendimiento
- El catálogo se guarda en el navegador (localStorage, sin imágenes). Medido con los datos reales: bodega 764 (Asamblea) con WooCommerce = 986 productos, **179 KB**; **solo su bodega = 883 productos, 161 KB**; bodega 738 (la más grande) = 1.785 productos, 324 KB; **peor caso, todos los 3.227 productos activos = 567 KB** (≈ 1,1 MB en UTF-16 de los ~5 MB de localStorage). Por eso **no hizo falta IndexedDB**; si un día el catálogo pasa de ~3 MB de texto habría que migrar (la cola de ventas ya usa localStorage y no cambia). Búsqueda por nombre, SKU y código de barras con ~1.800 productos: 74 ms; escribiendo letra por letra el peor cuadro fue 38 ms.
- Una caja con un catálogo viejo guardado (sin bodega) se abre, muestra ese catálogo y vende; la versión del catálogo depende de la bodega, así que se actualiza sola.

### Qué debe confirmar el contador antes de usarlo
1. Que **«Precio de venta 2»** es el precio de venta al público para los productos solo-Siigo (en los productos de WooCommerce coincide en el 97 %). Se cambia en Configuración sin tocar código.
2. Que facturar con `warehouse` descuenta el inventario de **esa bodega** en Siigo (la documentación no dice qué bodega usa Siigo si no se envía; con bodega asignada se envía siempre). Los comprobantes de prueba (6503) también pueden mover inventario: elimine el documento de prueba.
3. Qué hacer con los productos **sin control de inventario** (199 en Siigo) y con **existencias negativas** (17): el POS no bloquea ventas por inventario.
4. Los **servicios** (31 en Siigo: IBP Virtual, etc.) quedan fuera del catálogo por defecto; si se incluyen, se venden sin existencias.
5. Los **55 productos con IVA distinto** entre WooCommerce y Siigo siguen usando el IVA de Siigo al facturar (regla de siempre) y las cifras de WooCommerce en pantalla.

## 11h. Comprobante opcional, crédito a 60 días y tirilla estilo Siigo POS

### Foto del comprobante opcional
- Con **Transferencia** y **Tarjeta (datáfono)** la foto del comprobante es **opcional**, en la caja y en el servidor: el cliente valida las transacciones con su propio método interno. La **referencia** y la casilla *«Verifiqué el pago…»* siguen siendo **obligatorias** (sirven para conciliar). Con Efectivo, Crédito FECP y ePayco no cambia nada.
- `REQUIRE_RECEIPT_PHOTO=true` en `.env.production` vuelve a **exigir** la foto con Transferencia (la venta queda «Comprobante pendiente» hasta adjuntarla). La foto de la Tarjeta siempre fue opcional.
- Una venta sin foto **no** es error ni «pendiente»: en `/ventas` aparece **«Sin comprobante»** como dato (y se puede adjuntar después); el filtro «Comprobante pendiente» solo existe si la foto es obligatoria; en Reportes no aparece. Las filas «pendiente» viejas se muestran como «Sin comprobante». Las ventas en cola sin conexión con el formato anterior se siguen aceptando.

### Crédito FECP: un solo plazo
Gerencia autorizó **60 días**. La caja muestra «60 días · vence el …» (sin botones 14/30/90) y el servidor responde 400 («El Crédito FECP solo admite un plazo de 60 días») a cualquier otro. El valor está en `CREDITO_PLAZO_DIAS`. `SIIGO_PAYMENT_CREDITO_ID` no cambia. Las ventas ya hechas con otros plazos conservan el suyo; una venta en cola sin conexión con 14/30/90 días se rechaza al enviarse.

### Tirilla de 80 mm (modelo Siigo POS)
Orden: **logo** (`public/logo-fecp.png`, blanco y negro, ~30 mm; si el archivo no existe se imprime sin logo) · nombre en negrita (`NEGOCIO_NOMBRE`, en mayúsculas) · NIT con DV, dirección, ciudad y teléfono (`NEGOCIO_*`) · «Factura electrónica de venta», «No. <prefijo>-<número>» (lo que devuelve Siigo), fecha de generación y de expedición · cliente (nombre, **tipo y número de documento** con su etiqueta —«C.C.:», «NIT:» con DV, «C.E.:», «Pasaporte:»… según el tipo real—, dirección, teléfono) y **vendedor** (el cajero) · ítems con `Ít., Cant., Vr. Unit, Valor, ID` y debajo «nombre / código» · tabla de impuestos (`ID, %, Base, Impuesto`, letras A, B… según las tarifas de la venta, con su leyenda) · totales (Total ítems, Total bruto, Descuentos, Subtotal, IVA por tarifa, **Total a pagar**) · forma de pago (**Contado** o **Crédito (vence AAAA-MM-DD)**) y un renglón por método con su valor (más Recibido/Cambio en efectivo) · bodega, discreta · CUFE completo y QR de la DIAN · avisos legales (régimen y actividad, letra de cambio Ley 1231/2008, **número de autorización** con `RESOLUCION_DIAN_*`, fabricante del software de Siigo).
- Consumidor final: «Cliente: Consumidor final» y «Documento: 222222222222». Los campos vacíos (teléfono, dirección) se omiten.
- **Provisional** (sin conexión o antes de facturar): mismo diseño con «Comprobante provisional - no es factura»; sin número de factura, CUFE, QR ni avisos de la factura.
- El mismo componente se usa en la reimpresión de `/ventas`, la caja y el kiosco. En pantalla es un papel blanco con texto negro (también en modo oscuro) y se imprime siempre en blanco y negro.
- Los textos legales fijos están en `src/config/ticket-text.ts`; los demás datos vienen de variables o de Siigo. **El nombre del encabezado sale de `NEGOCIO_NOMBRE`: si en el `.env` está mal escrito («FUNDADACION EDUCACION…»), así sale en la tirilla.**

## 12. Comandos útiles

| Comando | Para qué |
|---|---|
| `npm run db:setup` | Crear/actualizar tablas |
| `npm run db:seed` | Crear administrador y Consumidor final |
| `npm run report:iva` | Genera `docs/productos-iva-diferente.csv` (IVA distinto entre WooCommerce y Siigo) |
| `npm run siigo:pruebas` | Lista los documentos de PRUEBA creados en Siigo para anularlos |
| `npm run build` / `npm start` | Producción local (sin Docker) |
| `node --env-file=.env.local db/prueba-kiosco-precio.mjs` | Regresión: el kiosco usa el precio real de la base |
| `node --env-file=.env.local db/prueba-kiosco-clientes.mjs` | Regresión: el kiosco no lee ni modifica la tabla de clientes |
| `deploy/backup.sh` / `deploy/restore.sh` | Respaldo y restauración en el servidor (ver [DEPLOY.md](DEPLOY.md), sección 5) |

**Dejar la base en cero antes del deploy** (borra **ventas, líneas de venta, referencias de pago y logs**; conserva productos, usuarios, clientes y configuración, y reinicia la numeración `K01`/`E01`):

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d fecp_pos -c "TRUNCATE sale_receipts, payment_refs, sale_items, sales, logs RESTART IDENTITY; ALTER SEQUENCE kiosk_sale_seq RESTART WITH 1;"
Remove-Item -Recurse -Force .\uploads\comprobantes\* -ErrorAction SilentlyContinue   # fotos de comprobantes de prueba
```

Es irreversible. Haz una copia antes si dudas (`pg_dump`). Si quieres también borrar los clientes de prueba, agrega `customers` al `TRUNCATE` (cuidado: Consumidor final lo recrea `npm run db:seed`). **No lo hagas después de sincronizar los clientes de Siigo**, o tendrás que volver a sincronizar (~5 min).

## 13. Pasar a facturación y cobros reales

> En el servidor las variables se editan en `.env.production` y se aplican con `docker compose up -d` (ver [DEPLOY.md](DEPLOY.md)). Los modos de prueba (`SIIGO_TEST_MODE`, `EPAYCO_TEST_MODE`) vienen en `true` por defecto.

1. Completa `RESOLUCION_DIAN_*`, `NEGOCIO_*` y `POS_ADDRESS`.
2. Confirma en **Configuración** que el vendedor y el comprobante `SIIGO_DOCUMENT_ID` existen.
3. Cambia `SIIGO_TEST_MODE=false` y reinicia. **Configuración** mostrará un aviso rojo: desde ese momento cada venta es una factura electrónica real enviada a la DIAN (no se puede borrar, solo anular con nota crédito).
4. **Pagos electrónicos:**
   - `EPAYCO_TEST_MODE=false` (con llaves de **producción** de ePayco).
   - `EPAYCO_SIIGO_PAYMENT_ID` = el id **real** de la forma de pago de ePayco en Siigo, escrito explícitamente en `.env.local`. El `5798` es solo de pruebas.
   - Seguridad incorporada: con `SIIGO_TEST_MODE=false` **y sin** `EPAYCO_SIIGO_PAYMENT_ID` explícito, el sistema **se niega** a facturar pagos electrónicos; y con `EPAYCO_TEST_MODE=true` junto a `SIIGO_TEST_MODE=false` tampoco factura un pago de prueba. El motivo aparece en **Configuración**.
   - Define `APP_PUBLIC_URL=https://tu-dominio` para activar el webhook y el QR de pago.
   - **Crédito FECP:** `SIIGO_PAYMENT_CREDITO_ID` = el id **real** de una forma de pago de Siigo con fecha de vencimiento (`due_date=true`; "Crédito" suele ser `1667`). Con `SIIGO_TEST_MODE=false` y la variable vacía el sistema **se niega** a facturar ventas a crédito (se ve en **Configuración**; *Probar conexión Siigo* comprueba que exista, esté activa y maneje vencimiento).
   - **Transferencia:** el `5798` es un valor de pruebas pendiente de confirmar: edita `src/config/siigo-map.ts` si FECP usa otra forma de pago.
5. Antes de abrir: deja la base en cero (sección 12) y anula los documentos de prueba en Siigo (`npm run siigo:pruebas`).

## 14. Cómo se evita facturar dos veces

1. El navegador genera el UUID de la venta y la guarda en el equipo **antes** de enviarla; el servidor ignora un UUID repetido (`ON CONFLICT DO NOTHING`).
2. Antes de facturar, la venta se “reclama” con un `UPDATE ... WHERE status IN ('pending','failed','pagado')`: solo un proceso puede facturarla.
3. Se envía a Siigo el header `Idempotency-Key` (UUID sin guiones, 30 caracteres): si el POST se repite, Siigo devuelve la misma factura.
4. Si hay timeout o error de red (no se sabe si se creó), la venta queda **“Por revisar”** y no se reintenta sola: primero se busca en Siigo una factura con el UUID en las observaciones. Una venta que lleva más de 10 minutos “Facturando” pasa sola a “Por revisar”.
5. **Pagos electrónicos:** cada `ref_payco` se procesa una sola vez; una venta solo pasa a `pagado` desde `esperando_pago` (transición atómica) y los pagos tardíos o dudosos jamás se facturan solos.

## Estructura

```
db/                 schema.sql, setup, seed y scripts de reportes
docs/               productos-iva-diferente.csv
public/             logo.webp
src/app/            páginas y API
  caja, ventas, ticket   caja, historial y tirilla
  kiosco                 autoservicio (rol cliente)
  pagar/[code]           páginas PÚBLICAS de pago por enlace y de respuesta
  admin/*                productos, clientes, usuarios, reportes, pagos-por-revisar, logs, configuración
  api/*                  endpoints (api/kiosco/pagos* = cobros de kiosco y caja; api/pagar = público; api/epayco = webhook)
src/components/     caja (CheckoutModal, EpaycoCharge), kiosco, ventas, tirilla y componentes compartidos
src/config/         tax-map.ts (Woo), siigo-map.ts (ids de Siigo), dane.json
src/lib/            permissions.ts, auth.ts, woo.ts, sales.ts, kiosk.ts, sale-states.ts, pay-link.ts,
                    customers.ts (búsqueda de clientes), epayco/* (adapter, process, verify, session, config),
                    siigo/* (incluye customer-sync.ts: sincronización de clientes), client/* (navegador)
```
