# PRUEBAS.md — Lista de chequeo manual para validar en caja

Marca cada punto con `[x]` cuando pase. Haz todo con `SIIGO_TEST_MODE=true` (los documentos de prueba se listan con `npm run siigo:pruebas`).

**Antes de empezar:** `.env.local` completo, `npm run db:setup`, `npm run build` y `npm start` corriendo; Chrome abierto con el acceso directo `--kiosk-printing`; impresora de 80 mm predeterminada; productos sincronizados; un usuario de cada rol creado.

---

## 1. Login y bloqueo
- [ ] Entrar con correo y contraseña correctos → abre la caja (cajero/admin) o el autoservicio `/kiosco` (cliente).
- [ ] Contraseña incorrecta → mensaje “Correo o contraseña incorrectos”.
- [ ] 5 contraseñas incorrectas seguidas → “Cuenta bloqueada 15 minutos”. Después, ni la clave correcta entra.
- [ ] Un admin restablece la contraseña (Usuarios) → el usuario bloqueado puede entrar.
- [ ] Desactivar un usuario que tiene la sesión abierta → en su siguiente acción lo saca al login.
- [ ] El logo se ve en el login y en la barra lateral.

## 2. Lector de códigos y búsqueda
- [ ] Con la pistola (foco fuera del buscador) leer un producto → se agrega y suena un beep suave.
- [ ] Leer el mismo código 3 veces → cantidad 3.
- [ ] Leer un código inventado → sonido de error y aviso “Código no encontrado: X”.
- [ ] Con el foco en el buscador, leer un código → agrega y limpia el campo.
- [ ] Escribir parte del nombre (con o sin tildes, en mayúsculas o minúsculas) → filtra al instante.
- [ ] Escribir un SKU y Enter → agrega el producto.
- [ ] Con el modal de cobro abierto, la pistola NO agrega productos al carrito.
- [ ] F2 enfoca el buscador.

## 3. Consumidor final (sin cédula)
- [ ] Agregar productos. Cobrar → el modal dice **paso 1 de 2: cliente** (tipo de documento CC por defecto y campo "Número de documento").
- [ ] Pulsar **Consumidor final** → pasa al pago (paso 2). Pagar en efectivo con “Exacto” → confirmar (F9).
- [ ] La tirilla sale a 80 mm: negocio, “PRUEBA – SIN VALIDEZ FISCAL” arriba y abajo, número de factura de prueba, IVA por tarifa.
- [ ] La venta aparece en `/ventas` como **Facturada** con su número `FV-1-…`.

## 4. Cliente con cédula (existente y nuevo)
- [ ] Escribir la cédula de un cliente que **existe** (Enter) → muestra nombre completo, tipo y número, y correo/teléfono con asteriscos (`d***@gmail.com`, `300***1234`). **Facturar a este cliente** → pago → factura a ese cliente, sin crear nada en Siigo.
- [ ] Un cliente al que le **falta** el correo o la ciudad: pide **solo eso**; el resto no cambia en **Admin → Clientes**.
- [ ] Una cédula que **no existe** → botones **Consumidor final** y **Factura electrónica a nombre del cliente** (formulario en blanco).
- [ ] **F9** en el paso 1 abre directo el formulario "a nombre del cliente".
- [ ] Repetir con la misma cédula (cliente nuevo ya creado) → "✓ Cliente encontrado".
- [ ] El cliente aparece en **Admin → Clientes** con 1 o más compras.
- [ ] ⚠ La primera vez con una cédula nueva se crea el cliente en el Siigo real.

## 5. Venta mayor a 5 UVT
- [ ] Con `CONSUMIDOR_FINAL_SIN_TOPE=true` (por defecto): base sin IVA > 5 UVT → **Consumidor final se puede usar** igual.
- [ ] Con `CONSUMIDOR_FINAL_SIN_TOPE=false` (y reiniciar): > 5 UVT → el botón **Consumidor final** queda deshabilitado con la explicación; hay que identificar al cliente. **Admin → Configuración** muestra el valor activo.
- [ ] El formulario "a nombre del cliente" no deja continuar sin documento, nombres/razón social, correo, dirección, departamento y ciudad.
- [ ] Con NIT, calcula el dígito de verificación.
- [ ] **Crédito FECP** con Consumidor final → vuelve al paso 1 con el mensaje "El Crédito FECP exige un cliente identificado…".
- [ ] **Sin internet** (apagar el wifi del equipo): "Buscar cliente" se deshabilita con un aviso; Consumidor final y el formulario manual siguen funcionando y la venta se encola.
- [ ] La tirilla muestra el tipo de documento en su propia línea ("Cédula de ciudadanía") y debajo el número.

## 6. Pagos
- [ ] Efectivo: botones $10.000/$20.000/$50.000/$100.000; el cambio sale en grande; con valor menor al total no deja confirmar.
- [ ] Tarjeta y Transferencia (cada línea del cobro): exigen la **referencia** y la casilla “Verifiqué el pago…”; sin ambas no deja confirmar.
- [ ] La referencia sale en la tirilla, en el historial y en Reportes (detalle por medio de pago).
- [ ] En Siigo la observación dice “PRUEBA POS - ELIMINAR | POS FECP venta {UUID} | {medio} ref {referencia}”.

## 7. Venta sin internet
- [ ] Desconectar internet del equipo (o Chrome → F12 → Network → *Offline* si el servidor está en otro equipo). El indicador pasa a “Sin conexión”.
- [ ] Hacer una venta → se imprime el **COMPROBANTE PROVISIONAL – NO ES FACTURA** con `C01-…` y la leyenda de factura pendiente.
- [ ] El indicador muestra “1 pendiente”. Seguir buscando productos con el catálogo guardado.
- [ ] Reconectar → en menos de 30 s se envía sola y se factura; aparece el aviso “La venta pendiente quedó facturada” con el botón **Reimprimir factura**.
- [ ] El indicador vuelve a 0 pendientes.

## 8. Reimpresión
- [ ] `/ventas` → **Reimprimir** en una venta facturada → sale la tirilla definitiva (número, CUFE + QR si es modo real).
- [ ] Reimprimir una venta sin facturar → sale como comprobante provisional.

## 9. Venta que Siigo rechaza
- [ ] Provocar un rechazo (p. ej. cambiar `SIIGO_PAYMENT`/SKU en una prueba controlada, o un producto que no exista en Siigo). La venta queda **Fallida**.
- [ ] Como **admin**: en `/ventas` → **Ver error** muestra el mensaje de Siigo.
- [ ] Como **cajero**: la misma venta aparece solo como “Fallida”, sin detalle técnico ni botón de reintento.
- [ ] **Admin → Logs** (tipo `factura`, nivel `error`) → **Ver detalle** muestra el error completo y la petición enviada.
- [ ] Corregir la causa y **Reintentar** → pasa a Facturada.
- [ ] **Admin → Configuración** lista la venta fallida mientras no se resuelva.

## 10. Una misma venta enviada dos veces no genera dos facturas
- [ ] Hacer una venta con internet y anotar su `FV-1-…`.
- [ ] Reenviar la misma venta (el script de pruebas de desarrollo, o repetir el POST con el mismo UUID) → el servidor responde `duplicate: true` y **no** crea otro documento.
- [ ] `npm run siigo:pruebas` muestra un único documento por esa venta.
- [ ] “Por revisar”: **Verificar en Siigo** busca el UUID; si existe, la vincula; si no, la pasa a Fallida.

## 11. Ventas anuladas y trabadas
- [ ] Una venta `anulada` no tiene botón de reintento, no suma en Reportes y no se factura nunca.
- [ ] Una venta que lleva más de 10 minutos en “Facturando” pasa sola a “Por revisar” (al abrir `/ventas` o Configuración).

---

## 12. Prueba por rol

### Cajero
- [ ] Entra y ve **solo** Ventas e Historial en la barra lateral (sin Productos ni Reportes).
- [ ] Escribir `http://localhost:3000/admin/logs` en la barra de direcciones → lo devuelve a la caja. Igual con `/admin/usuarios`, `/admin/reportes`, `/admin/configuracion`, `/admin/clientes`, `/admin/productos`.
- [ ] **Endpoints directos** (F12 → Consola, con la sesión del cajero abierta). Todos deben responder `403`:

```js
for (const [m, u] of [["GET","/api/admin/users"],["GET","/api/admin/siigo/taxes"],["POST","/api/admin/test/siigo"],["POST","/api/sync/products"]])
  fetch(u,{method:m}).then(r=>console.log(m,u,r.status));
```

- [ ] `fetch("/api/sales/<id-de-una-venta>/retry",{method:"POST"})` → `403`.
- [ ] `/ventas` muestra **solo sus ventas**; el botón **Hoy** muestra las de hoy y **Ayer** las de ayer (nunca las de otros cajeros).
- [ ] `fetch("/api/sales?date=2020-01-01").then(r=>r.json()).then(console.log)` → devuelve solo las suyas de **hoy** (otras fechas no se permiten), con `last_error: null`.
- [ ] Reimprimir una venta de otro cajero (`fetch("/api/sales/<id-ajeno>")`) → `403`.
- [ ] **Admin → Logs → Tipo: seguridad** muestra los intentos anteriores del cajero: un registro por ruta, con el contador de intentos.

### Administrador
- [ ] Ve todas las pantallas: Caja, Historial, Productos, Clientes, Usuarios, Reportes, Pagos por revisar, Logs, Configuración.
- [ ] Usuarios: crear uno de cada rol; editar su vendedor de Siigo; restablecer contraseña; desactivar.
- [ ] No puede desactivarse ni cambiarse el rol a sí mismo, ni dejar el sistema sin administradores activos.
- [ ] Reportes: totales del día, por cajero, por medio de pago (con referencias), top 10 productos. Las ventas anuladas no cuentan.
- [ ] Reportes muestra **Total recaudado** (todas las no anuladas) y **Total facturado** (solo facturadas). Si hay una venta fallida o pendiente, aparece la diferencia resaltada en rojo; si todo está facturado dice “Coinciden”.
- [ ] Logs: filtrar por fecha, tipo y nivel; **Ver detalle** abre el JSON.
- [ ] Configuración: *Probar conexión WooCommerce* y *Siigo* en verde; no se ven claves; con `SIIGO_TEST_MODE=false` aparece el aviso rojo.

### Cliente
- [ ] Al iniciar sesión solo ve el autoservicio (`/kiosco`).
- [ ] `/caja`, `/ventas`, `/admin/...` → lo devuelven a `/kiosco`.
- [ ] Los endpoints (`/api/products`, `/api/sales`, `/api/customers`, `/api/admin/users`) responden `403`.

---

## 12b. Pago electrónico (ePayco) — con `EPAYCO_TEST_MODE=true`
Abre la app por **`http://127.0.0.1:3000`** (no `localhost`). Tarjeta de prueba aprobada: `4575 6231 8229 0326`, fecha futura, CVV `123`.

### En la caja
- [ ] En el modal de cobro aparece **Pago electrónico (ePayco)**. Con llaves incompletas el botón sale gris con el motivo.
- [ ] Al elegirlo desaparecen la referencia y la casilla “Verifiqué el pago”; el botón dice **Cobrar con ePayco**.
- [ ] Se abre la ventana de ePayco; el panel muestra total, cuenta regresiva y “MODO DE PRUEBA”.
- [ ] Pagar con la tarjeta de prueba y cerrar el recibo → el panel pasa a **Pago recibido**, genera la factura y se abre la impresión de la tirilla. El carrito queda vacío.
- [ ] **Cancelar cobro** pide confirmación y deja el carrito intacto; la venta queda “Esperando pago” y vence sola a los 10 min (“Pago fallido”).
- [ ] Recargar la pestaña a mitad del pago → el panel se retoma solo.
- [ ] Si el total cambió (precios actualizados) antes de cobrar, avisa y pide confirmar el nuevo total.

### En el autoservicio
- [ ] **Paso "Ingrese su número de cédula"** (teclado grande): escribe 5 o más dígitos → mientras escribe no consulta nada; **Consultar** → "¿Es usted?" con nombre y cédula enmascarados (`DAN**** MUN**** ROD****`, `1018****`), aviso de la Ley 1581 y **Sí, soy yo / No, corregir**.
- [ ] **Sí, soy yo** → paso de contacto con correo y teléfono **vacíos** (no se prellenan). **No, corregir** → vuelve a escribir.
- [ ] Una cédula que no existe → **Consumidor final** y **Factura electrónica a mi nombre** (formulario en blanco).
- [ ] Más de 10 consultas en 10 minutos → mensaje de demasiadas consultas.
- [ ] Dejar la pantalla de "¿Es usted?" sin tocar 3 minutos → vuelve al inicio y la consulta desaparece.
- [ ] Pago aprobado → pantalla “¡Gracias por su compra!” con el número de factura; con `KIOSCO_IMPRESORA=true` imprime la tirilla.
- [ ] Sin conexión (apagar el wifi) → “Autoservicio no disponible, acérquese a la caja”.
- [ ] `Ctrl+Alt+Shift+K` abre el diálogo de salida; con credenciales de administrador cierra sesión; con 5 intentos fallidos se bloquea (revisa los logs).
- [ ] 3 minutos sin actividad → vacía el carrito y vuelve al inicio.

### Verificación y casos raros
- [ ] **Nunca** se factura sin que el servidor confirme con ePayco: en **Logs → pago** aparece “Verificando pago… PAGADO”.
- [ ] Pago **rechazado** → mensaje claro y “Intentar de nuevo” crea una venta nueva; no se factura.
- [ ] Pago aprobado **después** de vencer el cobro → queda “Pago tardío” y no se factura solo.
- [ ] Reportes: los pagos por revisar salen en la línea naranja aparte, no en recaudado/facturado.

### Pagos por revisar (`/admin/pagos-por-revisar`)
- [ ] Lista fecha, venta, cliente, monto, motivo y `ref_payco`.
- [ ] **Facturar** pide confirmación; al aceptar genera la factura y la venta sale de la lista.
- [ ] **Marcar para reembolso** pide confirmación; queda en “Marcadas para reembolso” con fecha y quién, no se factura y no cuenta en reportes. No se puede marcar ni facturar dos veces.
- [ ] **Cobros sin confirmar:** pegar el enlace `…?ref_payco=…` (o la referencia larga de 24 caracteres) de un pago real de prueba en una venta que quedó esperando → «Pago aprobado y verificado…» y la factura sale sola.
- [ ] Pegar el número corto (`395055851`) o el `x_transaction_id` (`395055851179545908`) → responde **al instante** «Eso parece la referencia corta / el número de transacción: con ese dato ePayco no permite consultar…» y explica dónde está la larga (nunca se queda en «Estamos verificando»).
- [ ] Pegar una referencia larga inventada → «ePayco no encontró esa referencia». En *Admin → Logs* (tipo pago) cada verificación muestra tipo de referencia, HTTP y tiempo.
- [ ] **Facturar con evidencia del webhook** (venta con aviso de pago aprobado sin confirmar): sin nota no deja; con nota factura **una vez**; un segundo clic dice que ya se resolvió. En una venta sin aviso el botón no aparece.
- [ ] Un cajero que abre `/admin/pagos-por-revisar` o llama a `/api/admin/pagos/...` recibe `403` (queda log de seguridad).

### Páginas públicas
- [ ] `/pagar/<código>` abre **sin iniciar sesión** y solo muestra número de compra, total y estado. Un código inventado → “Enlace no válido”.
- [ ] Con un celular en la misma red (o con `APP_PUBLIC_URL`): “Pagar ahora” abre ePayco; al terminar vuelve a **`/pagar/<código>/retorno`** y muestra «Pago aprobado. Ya puede volver al kiosco…» (o «Su pago está en proceso» / «El pago no se completó»).
- [ ] Con `APP_PUBLIC_URL` definido, el panel de cobro de la caja muestra el **QR**.
- [ ] Con `APP_PUBLIC_URL` definido y un dominio con HTTPS: el webhook confirma el pago aunque se cierre el navegador.

---

### Pantalla de elección, intentos y estados (kiosco y caja) — con `EPAYCO_TEST_MODE=true`
- [ ] Kiosco: tras los datos del cliente aparece **«¿Cómo desea pagar?»** con dos botones **del mismo tamaño**, la advertencia **«Escanee con la cámara del celular, NO desde la app de su banco»** bajo el del QR y *Volver* / *Cancelar compra*. **Todavía no** hay venta ni ventana de ePayco (en *Admin → Ventas* no aparece nada hasta elegir).
- [ ] **Cerrar la ventana de ePayco** sin pagar: pasa a «Verificando su pago con ePayco…» (sin «Abrir el pago de nuevo» ni QR, *Cancelar compra* deshabilitado) y en ≤ 15 s a **«Pago cancelado»** («Usted canceló el pago. No se hizo ningún cobro.»). **Intentar de nuevo** vuelve a la elección («Intento 2»); en los logs el nuevo intento sale con referencia `K01-…-2`.
- [ ] **Cancelar** dentro del checkout de ePayco (botón de ePayco): igual que arriba, nunca dice «rechazado».
- [ ] Tarjeta de prueba **rechazada** (ver arriba): «El pago fue rechazado» con *Intentar de nuevo* / *Cancelar*.
- [ ] **PSE pendiente** (elige PSE de prueba y no completes el pago en el banco): «Su pago está en proceso — No lo repita…», solo *Seguir esperando* y *Cancelar compra*. Al pulsar *Cancelar compra* avisa «Si ya realizó el pago, no se perderá…»; la venta queda en **Pagos por revisar**. Si en cambio completas el pago en el banco, la pantalla pasa sola a «¡Gracias por su compra!» y se factura una sola vez.
- [ ] **Webhook retrasado:** paga con tarjeta aprobada y cierra la pestaña antes de que vuelva; en ≤ ~30 s la venta aparece **Facturada** en *Ventas* sin intervención (consulta activa). Si no, revisa *Admin → Logs* (tipo pago, «consulta activa») y `EPAYCO_POLL_SECONDS`.
- [ ] **QR:** *Pagar con mi celular* muestra el QR y la advertencia; escanea con la **cámara** (no con la app del banco), paga: el kiosco avanza solo. Si el celular recibe un rechazo, el enlace dice «puede intentarlo» y el intento nuevo lleva referencia nueva; con un pago pendiente el enlace dice «en proceso, no lo repita».
- [ ] Caja: **Pago electrónico → Cobrar con ePayco** muestra «¿Cómo se va a cobrar?» (*Mostrar QR al cliente* / *Cobrar en esta pantalla*) con los mismos estados.
- [ ] Inactividad en la pantalla «Pago cancelado» o en la elección tras un reintento (3 min): el kiosco vuelve al inicio y la venta queda cancelada.
- [ ] Cerrar la ventana de ePayco **sin ninguna señal** (ni pago ni cancelación): tras 15 s → «No recibimos confirmación de su pago. ¿Completó el pago?» con **dos botones del mismo tamaño** («Sí, ya pagué (esperar)» / «No, intentar de nuevo») y *Cancelar compra*. «No, intentar de nuevo» abre un intento nuevo; «Sí, ya pagué» pasa a «Su pago está en proceso».
- [ ] QR: mientras el celular **no** haya abierto el enlace se puede «Cambiar forma de pago»; cuando el celular abre `/pagar/<código>` la pantalla dice «Este pago se abrió en un celular. Termine el pago allí o cancele la compra.» y ya no ofrece cambiar.
- [ ] Inactividad (3 min) en «en proceso» o «¿Completó el pago?»: el kiosco vuelve al inicio y la venta aparece en **Pagos por revisar** (no cancelada).
- [ ] **Reportes:** una venta electrónica en espera o rechazada no suma en *Total recaudado*, *Total facturado* ni en el cuadre de efectivo.
- [ ] Controles ≥ 44 px, sin scroll horizontal y buen contraste en modo oscuro (360, 768, 1024 y 1366 px).
- [ ] **QR:** junto al código dice «Termine el pago en su celular; si pagó por PSE puede tardar unos minutos».
- [ ] Con un aviso firmado de ePayco recibido y sin confirmar, kiosco y caja dicen **«Su pago está en proceso»** sin contador de tiempo; a los 10 min **no** pasa a «vencido» ni «rechazado» (la venta queda en *Pagos por revisar* con «ePayco avisó un pago aprobado que no se pudo confirmar automáticamente») y avanza sola a la factura si se confirma.

## 12b-real. Prueba real de ePayco (producción)

> Hazla **tú**, con dinero real de **bajo valor** (el producto más barato), con `EPAYCO_TEST_MODE=false` y las llaves de producción. Nada de esto se pudo verificar contra ePayco real durante el desarrollo: estos pasos confirman los supuestos que quedaron abiertos. Anota el número de compra (`K01-000123`) de cada paso. En el servidor las consultas SQL se corren así (cambia la consulta entre las comillas):
> ```bash
> dc exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT ..."'
> ```
> (En tu PC: `& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d fecp_pos -c "SELECT ..."`.)

**Consultas que se repiten en cada paso** (reemplaza `K01-000123`):
```sql
-- Estado de la venta
SELECT local_number, status, payment_status, payment_failure_reason, invoice_name, payment_expires_at
  FROM sales WHERE local_number = 'K01-000123';

-- Intentos de pago (referencia enviada a ePayco, estado, evidencia, QR abierto)
SELECT attempt_no, invoice, channel, status, ref_payco, webhook_at, qr_opened_at, checks, created_at, closed_at
  FROM payment_attempts WHERE sale_id = (SELECT id FROM sales WHERE local_number = 'K01-000123') ORDER BY attempt_no;

-- Referencias de ePayco procesadas y su resultado
SELECT ref_payco, outcome, reason, source, started_at, finished_at
  FROM payment_refs WHERE sale_id = (SELECT id FROM sales WHERE local_number = 'K01-000123') ORDER BY started_at;

-- Línea de tiempo (para medir cuánto tardó la factura): hooks, verificaciones, webhook, pago y factura
SELECT created_at, type, message FROM logs WHERE message LIKE '%K01-000123%' OR detail::text LIKE '%K01-000123%' ORDER BY id;
```

**a) Cerrar la ventana sin pagar → «¿Completó el pago?»**
1. En el kiosco arma una compra, elige **Pagar en esta pantalla** y cierra la ventana de ePayco sin pagar ni cancelar.
2. Esperado: «Verificando su pago con ePayco…» y, a los ~15 s, **«No recibimos confirmación de su pago. ¿Completó el pago?»** (si en cambio sale «Pago cancelado», ePayco informó la cancelación: también es correcto; anótalo).
3. SQL: el intento 1 debe estar `abierto`, con **`ref_payco` vacío** (sin evidencia). Pulsa **No, intentar de nuevo** → intento 2 `abierto` y el 1 `reemplazado`.

**b) Cancelar dentro de ePayco → «Intentar de nuevo» con referencia `-2`**
1. Pagar en pantalla; dentro del checkout de ePayco pulsa **Cancelar**.
2. Esperado: «Pago cancelado» («Usted canceló el pago. No se hizo ningún cobro.»). Pulsa **Intentar de nuevo** → elige **Pagar en esta pantalla**.
3. **Lo importante:** ePayco debe abrir el checkout sin error. SQL: el intento 2 con `invoice = 'K01-000123-2'`. Si ePayco rechaza el sufijo («invoice no válido», error al crear la sesión), anótalo: hay que cambiar el formato de la referencia. Completa el pago con tarjeta y confirma que la factura sale una sola vez y el intento 2 queda `aprobado`; en `payment_refs` la referencia aprobada debe corresponder al invoice `K01-000123-2` (columna `detail` → `invoice`).

**c) PSE: cerrar la ventana antes de volver al comercio**
1. Pagar en pantalla con **PSE**; en el banco aprueba el pago y **cierra la ventana de ePayco antes** de que regrese al kiosco.
2. SQL **mientras esperas**: ¿el intento tiene `ref_payco`? Anota **sí/no** — es la prueba clave: si es **sí**, el servidor puede consultar a ePayco por su cuenta; si es **no**, solo el webhook salvará el caso.
3. Mide con la línea de tiempo (consulta 4) el tiempo entre el cierre de la ventana y el log «Pago de K01-000123: PAGADO», y hasta la factura. Esperado: pantalla «Su pago está en proceso» (con evidencia) o «¿Completó el pago?» (sin ella); si eliges «Sí, ya pagué», debe facturar sola en `EPAYCO_POLL_SECONDS` (20 s) tras llegar el pago, sin repetir el cobro.
4. Anota también: ¿llegó el webhook? (`webhook_at` del intento) y ¿cuántas consultas activas hubo? (`checks`).

**d) QR con la cámara del celular**
1. Elige **Pagar con mi celular (QR)**; escanea con la **cámara** (no desde la app del banco) y paga con tarjeta.
2. Esperado: al abrir el enlace, el kiosco dice «Este pago se abrió en un celular…» y ya no deja cambiar de forma de pago; al aprobarse, el kiosco **avanza solo** a «¡Gracias por su compra!».
3. SQL: `qr_opened_at` con fecha en el intento QR, `status = 'aprobado'`; la venta `invoiced`.

**e) PSE por QR en el celular (el caso de K01-000025)**
1. En el kiosco elige **Pagar con mi celular (QR)**; escanea con la **cámara** y en el celular paga con **PSE** (aprueba en el banco). Cuando el banco termine, **deja que el celular vuelva** a la página del POS.
2. Esperado en el celular: la dirección es `https://pos.fecp.me/pagar/<código>/retorno?ref_payco=…` y dice **«Pago aprobado. Ya puede volver al kiosco…»** (o «Su pago está en proceso» unos segundos). En el kiosco: «Su pago está en proceso» y luego la factura, sin tocar nada.
3. SQL: el intento QR con `ref_payco` (24 caracteres) **lleno**, `webhook_at` y `webhook_approved_at` con fecha, `ref_used = 'larga'`, `status = 'aprobado'`; la venta `invoiced` una sola vez. Consulta extra:
   ```sql
   SELECT attempt_no, status, ref_payco, ref_used, webhook_approved_at, webhook_summary->>'x_franchise' AS franquicia,
          webhook_summary->>'x_cod_response' AS cod, evidence_at, evidence_note
     FROM payment_attempts WHERE sale_id = (SELECT id FROM sales WHERE local_number = 'K01-000123');
   ```
4. **Variante «no vuelve»:** repite pero **cierra el navegador del celular** en el banco, sin volver al POS. Esperado: el webhook llega (log «Webhook firmado de K01-… (APROBADO) sin poder confirmarlo…»), el kiosco sigue en «Su pago está en proceso» y a los 10 min la venta queda en **Pagos por revisar** (`por_confirmar`, **no** `pago_fallido`). Resuélvela con **Verificar con referencia** (busca la referencia larga en el detalle de la transacción del panel de Davipay) o, si no la encuentras y ya comprobaste que el dinero entró, con **Facturar con evidencia del webhook** (nota obligatoria). Anota **si el panel de Davipay muestra la referencia larga** y en qué campo: con eso se completa la documentación.
5. Anota si ePayco devolvió el celular a `/retorno` (en el log «Retorno del celular de K01-… con la referencia larga») y cuánto tardó.

Al terminar, borra o anula en Siigo las facturas de prueba y **reembolsa en el panel de ePayco** los cobros de estos pasos si no fueron ventas reales.

## 12c. Seguridad de precios

### Regresión del KIOSCO (hay que correrla siempre que se toque `src/lib/kiosk.ts` o el cobro electrónico)
El kiosco (rol cliente) y el cobro electrónico de la caja **solo mandan `product_id` y cantidad**; el precio, el IVA y el total salen de la tabla `products`.
```powershell
node --env-file=.env.local db/prueba-kiosco-precio.mjs http://127.0.0.1:3000
```
- [ ] Manda `price=1`, `unit_price=1`, `tax_rate=0` y `total=1` y comprueba que la venta se guardó con el **precio, IVA y total REALES** (no $1). Termina con `RESULTADO: OK` y código de salida 0.
- [ ] Cantidad 0, negativa y producto inexistente → 400.
- [ ] El script borra la venta y el usuario temporal que crea (con `EPAYCO_TEST_MODE=true` la sesión de ePayco es de prueba: no cobra dinero).

### Validación de precios en la CAJA (`/api/sales`)
- [ ] Una venta con `unit_price=1` de un producto de $12.600 **se acepta y se guarda**, queda `pending` con "Precio por revisar" en `last_error` y **NO se factura**.
- [ ] Aparece en **Admin → Precios por revisar** con la diferencia por línea, el cajero, la hora y cuánto lleva retenida; el menú y Reportes muestran el contador.
- [ ] Precio igual al vigente → se factura normal. Precio vigente hace menos de `PRICE_HISTORY_HOURS` (72 h) tras un cambio → se factura. Más viejo → se retiene.
- [ ] Diferencia solo de IVA, solo de SKU, producto inexistente o sin `product_id` → se acepta y se retiene (nunca error 4xx).
- [ ] Pago dividido y crédito con precio alterado → se retienen igual.
- [ ] **Reintentar** en `/ventas` no factura una retenida (409). **Aprobar y facturar** (dos clics a la vez) → una sola factura. **Anular** exige una nota (mín. 5 caracteres).
- [ ] Una anulada con dinero cobrado sale en **Reportes → Ventas anuladas con dinero cobrado** y en el cuadre de efectivo, y no cuenta en "Total recaudado" ni "Total facturado".
- [ ] Un cajero no ve el panel y sus endpoints responden 403.
- [ ] A las 2 h retenida → "atrasada"; a las 4 h → rojo.

## 12d. Clientes de Siigo

- [ ] **Admin → Clientes → Sincronizar clientes** (primera vez): barra de progreso hasta 100 %, ~5 minutos. Al terminar: "Clientes en el POS" ≈ los clientes activos de Siigo, fecha de última sincronización, y el historial con creados/omitidos/errores.
- [ ] Pulsarlo otra vez enseguida: trae solo lo modificado (1–2 peticiones) y no cambia nada.
- [ ] Con una sincronización en curso, abrir **Clientes** en otro navegador y pulsar el botón → mensaje "Ya hay una sincronización en curso".
- [ ] Reiniciar el contenedor a mitad (`dc restart app`): después de ~3 minutos la pantalla dice *Interrumpida* y **Retomar sincronización** continúa desde la página donde iba.
- [ ] Caja: un cliente **inactivo** en Siigo no se ofrece (se trata como no encontrado).
- [ ] Caja: escribir la cédula completa de un cliente creado **hoy** en Siigo (no está en el POS) → aparece (consulta en vivo de un intento, 4 s); en **Admin → Logs** (tipo sync) queda la búsqueda con el documento como `***123`.
- [ ] Elegir un cliente sincronizado: se factura sin pedir datos (si le faltan, solo esos); con **Crédito FECP** y un cliente con cédula/NIT, correo y dirección → se factura con vencimiento.
- [ ] Como cajero: abrir `/admin/clientes` → te devuelve a la caja. Como kiosco (rol cliente): `/api/customers?identification=123456` → 403.
- [ ] El cliente **Consumidor final** sigue igual.
- [ ] **Regresión de privacidad del kiosco** (córrela siempre que se toque `src/app/api/customers`, `src/lib/kiosk.ts` o la tirilla del kiosco):
  ```powershell
  node --env-file=.env.local db/prueba-kiosco-clientes.mjs http://127.0.0.1:3000
  ```
  Termina con `RESULTADO: OK` y código 0. Comprueba que el rol *cliente* recibe **403** en `/api/customers` y en `/api/admin/clientes/sync`; que `POST /api/kiosco/cliente` devuelve **solo datos enmascarados** (y `{"found":false}` idéntico para todo lo demás); que el cobro del kiosco con la cédula de un cliente existente **no lo modifica** aunque el navegador mande otro nombre, id de Siigo o customer_id, ni devuelve sus datos; y que la tirilla del kiosco solo muestra `***` + 3 dígitos. Borra todo lo que crea.

## 12e. Catálogo unificado y bodega de Siigo

> Requiere `db:setup`. Las pruebas con Siigo real solo leen (GET), salvo UNA factura de prueba (comprobante 6503): elimínela en Siigo al terminar.

- [ ] **Admin → Productos → Sincronizar productos de Siigo** (primera vez ~1 min): barra de progreso «página X de Y» y, al final, el resumen (creados, unidos con WooCommerce, omitidos, ambiguos, con error). Mientras corre los dos botones quedan deshabilitados.
- [ ] Pulsarlo mientras corre (o mientras corre la de WooCommerce) → «Ya hay una sincronización de productos en curso».
- [ ] La tabla muestra el **Origen** (WooCommerce / Siigo / Ambos), el marcador con iniciales en los de Siigo y las **Existencias** de la bodega elegida en el selector.
- [ ] Un producto de WooCommerce conserva nombre, foto, categoría y precio después de sincronizar Siigo; el resumen avisa cuántos tienen IVA/precio distinto (no se cambian).
- [ ] **Admin → Usuarios:** el selector «Bodega Siigo» lista las bodegas activas; «Actualizar bodegas» consulta Siigo; cambiar la bodega de un usuario se guarda.
- [ ] **Admin → Configuración → Catálogo de Siigo y bodegas:** bodega por defecto, minutos de existencias (5–1440, 0 = apagado), lista de precios, tipos de producto y «incluir WooCommerce» por bodega.
- [ ] **Caja como admin:** «Vendiendo desde: …» permite cambiar de bodega (con el carrito vacío); el catálogo cambia; queda el log «Cambio de bodega de la sesión de caja». Al cerrar sesión y volver a entrar vuelve a la suya.
- [ ] **Caja como cajero:** ve «Vendiendo desde: …» sin selector. El catálogo trae los productos de su bodega (aunque la cantidad sea 0) y los de WooCommerce.
- [ ] **Kiosco del evento:** en Configuración quite «incluir WooCommerce» de la bodega del evento (p. ej. «6 ASAMBLEA DTO 9 Y 22 NOV 2026»): el kiosco muestra solo los productos de esa bodega, sin selector ni nombre de bodega.
- [ ] **Factura:** venta de un producto solo-Siigo + uno de WooCommerce → en Siigo, cada ítem de la factura muestra la bodega del usuario y las observaciones traen «Bodega …» después del UUID. La tirilla muestra «Bodega».
- [ ] **Sin conexión:** desconecte la caja, venda, reasigne el usuario a otra bodega, reconecte: la venta se factura con la bodega **original**.
- [ ] Un cajero con la sesión abierta no puede vender con otra bodega (manipulando la pantalla): responde «La bodega de esta venta no corresponde a su usuario…».
- [ ] Producto de WooCommerce que no existe en Siigo → la venta queda «Fallida» con «no existe en Siigo…» y no se factura.
- [ ] **Reportes:** filtro «Bodega» y tabla «Por bodega de Siigo».
- [ ] La caja con catálogo grande (~1.800 productos) busca por nombre, SKU y código de barras sin trabarse.

## 12f. Comprobante opcional, crédito a 60 días y tirilla

- [ ] **Caja → Transferencia** sin foto: con la referencia y la casilla «Verifiqué el pago…» se puede confirmar; dice «Comprobante (opcional)». Sin la casilla o sin referencia **no** deja confirmar. Con foto también se acepta. Igual con **Tarjeta**.
- [ ] En **/ventas** esa venta dice «Sin comprobante» (gris, sin alerta, sin «Comprobante pendiente») y tiene «Adjuntar comprobante». En **Reportes** no aparece nada de comprobantes pendientes.
- [ ] Con `REQUIRE_RECEIPT_PHOTO=true` (reinicia con `dc up -d`): la transferencia exige la foto y la venta sin ella queda «Comprobante pendiente»; la tarjeta sigue siendo opcional.
- [ ] Venta hecha **sin conexión** con la versión anterior (formato viejo en la cola): al volver la conexión se envía y se factura.
- [ ] **Crédito FECP** (cliente con cédula/NIT y datos completos): muestra «60 días · vence el …» y no hay botones 14/30/90; la tirilla dice «Crédito (vence AAAA-MM-DD)».
- [ ] **Tirilla** (imprime o usa la vista previa a 80 mm): logo centrado, nombre en negrita **con tildes**, NIT/dirección/teléfono, «Factura electrónica de venta» + número, fechas, cliente con «C.C.:»/«NIT:» (con DV)/«C.E.:», vendedor, ítems con letra de impuesto y «nombre / código», tabla de impuestos con leyenda, totales, forma y métodos de pago, CUFE y QR, avisos legales con la autorización de la resolución. Nada se corta ni sale «null»/«undefined».
- [ ] Casos: Consumidor final · C.C. · NIT con DV · cliente sin teléfono · IVA 0 % y 19 % en la misma venta · pago dividido · crédito · **provisional** sin conexión («Comprobante provisional - no es factura», sin CUFE/QR) · reimpresión desde /ventas.
- [ ] Sin el archivo `public/logo-fecp.png` la tirilla se imprime igual, sin logo.

## 13. Antes de pasar a producción
- [ ] `RESOLUCION_DIAN_*`, `NEGOCIO_*` y `POS_ADDRESS` completos.
- [ ] FECP corrigió (o aceptó) los productos de `docs/productos-iva-diferente.csv`.
- [ ] Todos los documentos de prueba fueron anulados en Siigo (`npm run siigo:pruebas`).
- [ ] Cada cajero tiene su `siigo_seller_id`.
- [ ] Hecha **una** venta real de bajo valor con `SIIGO_TEST_MODE=false`, verificando número `FE…`, CUFE y QR en la tirilla y la aceptación en Siigo.
- [ ] ePayco: `EPAYCO_TEST_MODE=false` con llaves de producción, `EPAYCO_SIIGO_PAYMENT_ID` real escrito en `.env.local` y `APP_PUBLIC_URL` con HTTPS. Hecho **un** cobro real de bajo valor (caja y/o autoservicio) y comprobado que entra en ePayco y se factura.
- [ ] Base en cero antes de abrir (README, sección 12): sin ventas ni logs de prueba.
