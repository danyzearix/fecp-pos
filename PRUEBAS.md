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
- [ ] **Cobros sin confirmar:** pegar el enlace `…landingresume?ref_payco=…` de un pago real de prueba en una venta que quedó esperando → el servidor lo verifica y la factura sale sola.
- [ ] Un cajero que abre `/admin/pagos-por-revisar` o llama a `/api/admin/pagos/...` recibe `403` (queda log de seguridad).

### Páginas públicas
- [ ] `/pagar/<código>` abre **sin iniciar sesión** y solo muestra número de compra, total y estado. Un código inventado → “Enlace no válido”.
- [ ] Con un celular en la misma red (o con `APP_PUBLIC_URL`): “Pagar ahora” abre ePayco; al terminar vuelve a `/pagar/<código>/respuesta` y muestra la factura.
- [ ] Con `APP_PUBLIC_URL` definido, el panel de cobro de la caja muestra el **QR**.
- [ ] Con `APP_PUBLIC_URL` definido y un dominio con HTTPS: el webhook confirma el pago aunque se cierre el navegador.

---

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

## 13. Antes de pasar a producción
- [ ] `RESOLUCION_DIAN_*`, `NEGOCIO_*` y `POS_ADDRESS` completos.
- [ ] FECP corrigió (o aceptó) los productos de `docs/productos-iva-diferente.csv`.
- [ ] Todos los documentos de prueba fueron anulados en Siigo (`npm run siigo:pruebas`).
- [ ] Cada cajero tiene su `siigo_seller_id`.
- [ ] Hecha **una** venta real de bajo valor con `SIIGO_TEST_MODE=false`, verificando número `FE…`, CUFE y QR en la tirilla y la aceptación en Siigo.
- [ ] ePayco: `EPAYCO_TEST_MODE=false` con llaves de producción, `EPAYCO_SIIGO_PAYMENT_ID` real escrito en `.env.local` y `APP_PUBLIC_URL` con HTTPS. Hecho **un** cobro real de bajo valor (caja y/o autoservicio) y comprobado que entra en ePayco y se factura.
- [ ] Base en cero antes de abrir (README, sección 12): sin ventas ni logs de prueba.
