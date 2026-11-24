-- Esquema FECP POS. Se puede ejecutar varias veces (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','cajero','cliente')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,   -- intentos fallidos seguidos
  locked_until    TIMESTAMPTZ,                  -- bloqueo de 15 min tras 5 fallos
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Vendedor de Siigo del cajero (si es NULL se usa SIIGO_SELLER_ID del .env). Editable en /admin/usuarios (etapa 5).
ALTER TABLE users ADD COLUMN IF NOT EXISTS siigo_seller_id INTEGER;

CREATE TABLE IF NOT EXISTS products (
  id                 SERIAL PRIMARY KEY,
  woo_id             BIGINT NOT NULL UNIQUE,   -- id del producto o de la variación en Woo
  sku                TEXT,                     -- NULL = sin SKU, no se puede facturar
  barcode            TEXT,
  name               TEXT NOT NULL,
  price              NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate           INTEGER NOT NULL DEFAULT 19 CHECK (tax_rate IN (0,5,19)),
  prices_include_tax BOOLEAN NOT NULL DEFAULT TRUE,
  image_url          TEXT,
  category           TEXT,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Fuente fiscal = Siigo. tax_rate es la tarifa EFECTIVA (la de Siigo cuando se conoce; si no, la de Woo).
ALTER TABLE products ADD COLUMN IF NOT EXISTS woo_tax_rate INTEGER;          -- tarifa según WooCommerce (para el reporte de diferencias)
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_tax_class TEXT;          -- 'Taxed' | 'Exempt' | 'Excluded' | NULL = sin verificar / no existe en Siigo
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_checked_at TIMESTAMPTZ;  -- última vez que se consultó en Siigo
UPDATE products SET woo_tax_rate = tax_rate WHERE woo_tax_rate IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_sku     ON products (sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode);
CREATE INDEX IF NOT EXISTS idx_products_name    ON products (name);

CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  id_type        TEXT NOT NULL CHECK (id_type IN ('13','31','22','41')),
  identification TEXT NOT NULL UNIQUE,
  check_digit    TEXT,                          -- dígito de verificación (NIT)
  first_name     TEXT,
  last_name      TEXT,
  company_name   TEXT,
  email          TEXT,
  phone          TEXT,
  address        TEXT,
  state_code     TEXT,
  city_code      TEXT,
  siigo_synced   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sales (
  id                UUID PRIMARY KEY,           -- lo genera el navegador
  local_number      TEXT NOT NULL,              -- ej. C01-000123
  cashier_id        INTEGER NOT NULL REFERENCES users(id),
  customer_id       INTEGER REFERENCES customers(id),
  checkout_type     TEXT NOT NULL CHECK (checkout_type IN ('corto','completo')),
  subtotal          NUMERIC(14,2) NOT NULL,
  tax_total         NUMERIC(14,2) NOT NULL,
  total             NUMERIC(14,2) NOT NULL,
  payment_method    TEXT NOT NULL,
  cash_received     NUMERIC(14,2),
  change_given      NUMERIC(14,2),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','invoicing','invoiced','failed','revisar','anulada')),
  siigo_invoice_id  TEXT,
  invoice_name      TEXT,
  cufe              TEXT,
  last_error        TEXT,
  raw_response      JSONB,
  created_at_device TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Referencia / últimos dígitos del comprobante (tarjeta o transferencia). NULL en efectivo.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales (created_at);
CREATE INDEX IF NOT EXISTS idx_sales_status  ON sales (status);

CREATE TABLE IF NOT EXISTS sale_items (
  id         SERIAL PRIMARY KEY,
  sale_id    UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  sku        TEXT,
  name       TEXT NOT NULL,
  quantity   NUMERIC(12,3) NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL,
  tax_rate   INTEGER NOT NULL,
  line_total NUMERIC(14,2) NOT NULL
);
-- ¿unit_price ya incluía IVA cuando se vendió? Lo necesita la facturación para calcular la base.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);

-- Pares clave/valor del sistema (ej. fecha de la última sincronización de productos)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  type       TEXT NOT NULL CHECK (type IN ('venta','factura','sync','login','error','admin','seguridad','pago')),
  user_id    INTEGER,
  message    TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs (created_at);
CREATE INDEX IF NOT EXISTS idx_logs_type    ON logs (type);

-- ---------------------------------------------------------------------------
-- Migraciones para bases que ya existían (los CHECK de arriba solo aplican al crear la tabla).
-- Se pueden ejecutar varias veces.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','cajero','cliente'));

-- 'anulada': venta cancelada a mano. Nunca se factura, no aparece en reintentos ni en reportes. No se borra la fila.
-- (La restricción sales_status_check se define UNA sola vez, más abajo, con la lista completa de estados. NO volver a
--  crearla aquí con una lista parcial: al re-ejecutar este archivo fallaría si ya hay ventas en estados nuevos.)

-- Desde cuándo está en 'invoicing': si pasa de 10 min se manda a 'revisar' (servidor caído a mitad de facturar)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoicing_started_at TIMESTAMPTZ;

-- (logs_type_check: igual, se define una sola vez al final de este archivo con la lista completa de tipos.)

-- ---------------------------------------------------------------------------
-- Etapa 5B: autoservicio con pago electrónico (ePayco)
-- ---------------------------------------------------------------------------
-- Estados nuevos: esperando_pago, pagado, pago_fallido, pago_por_revisar, pago_tardio (definidos en src/lib/sale-states.ts)
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_status_check CHECK (status IN (
  'pending','invoicing','invoiced','failed','revisar','anulada',
  'esperando_pago','pagado','pago_fallido','pago_por_revisar','pago_tardio'));

ALTER TABLE sales ADD COLUMN IF NOT EXISTS source                 TEXT NOT NULL DEFAULT 'caja';  -- 'caja' | 'kiosco'
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status         TEXT;        -- último estado de ePayco: esperando|pendiente|aprobado|rechazado|por_revisar|tardio
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_failure_reason TEXT;        -- motivo legible si el pago falló o quedó por revisar
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_expires_at     TIMESTAMPTZ; -- el cobro vence 10 min después de crearse
ALTER TABLE sales ADD COLUMN IF NOT EXISTS epayco_session_id      TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS epayco_ref             TEXT;        -- ref_payco aprobado (también queda en payment_reference)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS epayco_transaction_id  TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS pay_token              TEXT;        -- código aleatorio para la URL pública /pagar/<código> (modo con dominio)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS notify_email           TEXT;        -- correo escrito en el kiosco: solo para enviar ESTA factura, no modifica al cliente
ALTER TABLE sales ADD COLUMN IF NOT EXISTS refund_requested_at    TIMESTAMPTZ; -- constancia de "marcar para reembolso" (el reembolso se hace en ePayco)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS refund_requested_by    INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_pay_token ON sales (pay_token) WHERE pay_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_local_number ON sales (local_number);
CREATE SEQUENCE IF NOT EXISTS kiosk_sale_seq;  -- numera las ventas del kiosco (K01-000001), único en todo el sistema

-- Cada ref_payco se procesa UNA sola vez (clave primaria = reclamo atómico)
CREATE TABLE IF NOT EXISTS payment_refs (
  ref_payco   TEXT PRIMARY KEY,
  sale_id     UUID NOT NULL REFERENCES sales(id),
  outcome     TEXT NOT NULL CHECK (outcome IN ('procesando','aprobado','rechazado','por_revisar','tardio','duplicado')),
  reason      TEXT,
  amount      NUMERIC(14,2),
  source      TEXT,                       -- 'kiosco' | 'webhook'
  detail      JSONB,                      -- datos normalizados de la transacción (sin llaves ni firmas)
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_refs_sale ON payment_refs (sale_id);
CREATE INDEX IF NOT EXISTS idx_payment_refs_outcome ON payment_refs (outcome);

ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_type_check;
ALTER TABLE logs ADD CONSTRAINT logs_type_check CHECK (type IN ('venta','factura','sync','login','error','admin','seguridad','pago'));

-- ---------------------------------------------------------------------------
-- Canales de pago de ePayco (uno a la vez) y pagos duplicados
-- ---------------------------------------------------------------------------
-- 'qr' = el cliente paga en su celular con /pagar/<código>; 'pantalla' = checkout onpage en el equipo (caja/kiosco).
-- Solo UNO está abierto: cambiar de canal cierra el otro (el enlace muestra "Este cobro fue cambiado").
ALTER TABLE sales ADD COLUMN IF NOT EXISTS pay_channel            TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS pay_channel_changed_at TIMESTAMPTZ;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_pay_channel_check;
ALTER TABLE sales ADD CONSTRAINT sales_pay_channel_check CHECK (pay_channel IS NULL OR pay_channel IN ('qr','pantalla'));

-- Un SEGUNDO pago aprobado de la misma venta (outcome 'duplicado') nunca se factura: queda para reembolso en Pagos por revisar.
ALTER TABLE payment_refs ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ;
ALTER TABLE payment_refs ADD COLUMN IF NOT EXISTS refund_requested_by INTEGER;

-- ---------------------------------------------------------------------------
-- Comprobantes de pago (foto del voucher o de la transferencia). Ver src/lib/receipts.ts
-- ---------------------------------------------------------------------------
-- Una fila por venta (una imagen por venta). Estados:
--   'pendiente' = transferencia registrada sin foto todavía (llega después, p. ej. desde la cola sin conexión)
--   'activo'    = hay archivo (file_path relativo a RECEIPTS_DIR; nombre UUID, nunca el del navegador)
--   'eliminado' = el archivo se borró por retención (RECEIPT_RETENTION_DAYS); el registro se conserva con deleted_at
CREATE TABLE IF NOT EXISTS sale_receipts (
  sale_id        UUID PRIMARY KEY REFERENCES sales(id),
  status         TEXT NOT NULL,
  file_path      TEXT,
  mime_type      TEXT,
  size_bytes     INTEGER,      -- después de comprimir
  original_bytes INTEGER,      -- lo que mandó el navegador
  width          INTEGER,
  height         INTEGER,
  uploaded_at    TIMESTAMPTZ,
  uploaded_by    INTEGER REFERENCES users(id),
  deleted_at     TIMESTAMPTZ,  -- fecha de eliminación por retención
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sale_receipts DROP CONSTRAINT IF EXISTS sale_receipts_status_check;
ALTER TABLE sale_receipts ADD CONSTRAINT sale_receipts_status_check CHECK (status IN ('activo','pendiente','eliminado'));
CREATE INDEX IF NOT EXISTS idx_sale_receipts_status ON sale_receipts (status);

-- ---------------------------------------------------------------------------
-- Verificación de pagos de ePayco: aviso del webhook sin referencia larga e intentos sin resolver
-- ---------------------------------------------------------------------------
-- El webhook a veces llega solo con la referencia CORTA (con la que ePayco no deja consultar la transacción). Se anota que
-- llegó un aviso firmado, sin decidir nada; el panel lo muestra y la confirmación llega con la referencia larga.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS webhook_hint_at   TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS webhook_hint_ref  TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS webhook_hint_txid TEXT;
-- Intentos de verificación que no se pudieron resolver (a los 60 pasa a "por revisar" para que un admin lo vea)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS verify_attempts   INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- PAGO DIVIDIDO: sale_payments (una fila por línea de pago de una venta)
-- ---------------------------------------------------------------------------
-- Una venta tiene 1 a 4 líneas, una por medio. Los reportes, el cuadre y /ventas calculan desde AQUÍ.
-- amount = monto APLICADO a la venta (en efectivo, lo cobrado de la venta, no el billete entregado).
-- Las columnas viejas de sales (payment_method, payment_reference, cash_received, change_given) se CONSERVAN por
-- compatibilidad: para una venta con varias líneas, sales.payment_method vale 'mixto'.
CREATE TABLE IF NOT EXISTS sale_payments (
  id            SERIAL PRIMARY KEY,
  sale_id       UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,                 -- efectivo | tarjeta | transferencia | credito_fecp | epayco  (+ históricos tarjeta_debito, tarjeta_credito)
  amount        NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  reference     TEXT,
  cash_received NUMERIC(14,2),                 -- solo la línea de efectivo
  change_given  NUMERIC(14,2),                 -- solo la línea de efectivo
  credit_days   INTEGER,                       -- solo crédito: 14 | 30 | 60 | 90
  due_date      DATE,                          -- solo crédito: fecha de la venta + plazo
  ord           SMALLINT NOT NULL DEFAULT 1,   -- orden de la línea en la venta
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sale_id, ord),
  UNIQUE (sale_id, method)                     -- una línea por medio
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale   ON sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_method ON sale_payments (method);
CREATE INDEX IF NOT EXISTS idx_sale_payments_due    ON sale_payments (due_date) WHERE due_date IS NOT NULL;

-- MIGRACIÓN (idempotente, no borra ni reescribe nada): cada venta que aún no tiene líneas recibe UNA con sus datos actuales.
-- El medio se copia tal cual ("tarjeta_debito" sigue mostrándose como Tarjeta débito). Las columnas de sales no se tocan.
INSERT INTO sale_payments (sale_id, method, amount, reference, cash_received, change_given, ord)
SELECT s.id, s.payment_method, s.total, s.payment_reference, s.cash_received, s.change_given, 1
  FROM sales s
 WHERE NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)
   AND s.payment_method <> 'mixto';

-- ---------------------------------------------------------------------------
-- VALIDACIÓN DE PRECIOS EN LA CAJA
-- ---------------------------------------------------------------------------
-- Historial de precios: una fila por "versión" de un producto (precio, IVA y SKU) con su vigencia. valid_to NULL = vigente.
-- Lo llena un DISPARADOR sobre products, así cualquier cambio (sincronización completa, incremental, o la de IVA con Siigo)
-- queda registrado sin depender de cada código que escriba en products.
-- Regla (src/lib/price-check.ts): una línea de venta de la caja es válida si coincide con el precio, IVA y SKU vigentes, o con
-- alguno vigente en las últimas PRICE_HISTORY_HOURS horas (72 por defecto). Cualquier diferencia retiene la venta.
CREATE TABLE IF NOT EXISTS product_price_history (
  id                 BIGSERIAL PRIMARY KEY,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                TEXT,
  price              NUMERIC(14,2) NOT NULL,
  tax_rate           INTEGER NOT NULL,
  prices_include_tax BOOLEAN NOT NULL,
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to           TIMESTAMPTZ          -- NULL = es la versión vigente
);
CREATE INDEX IF NOT EXISTS idx_pph_product ON product_price_history (product_id, valid_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pph_open ON product_price_history (product_id) WHERE valid_to IS NULL;

-- Línea base (idempotente): los valores ACTUALES de cada producto que aún no tenga historial, vigentes "desde siempre".
INSERT INTO product_price_history (product_id, sku, price, tax_rate, prices_include_tax, valid_from)
SELECT p.id, p.sku, p.price, p.tax_rate, p.prices_include_tax, TIMESTAMPTZ 'epoch'
  FROM products p
 WHERE NOT EXISTS (SELECT 1 FROM product_price_history h WHERE h.product_id = p.id);

-- Disparador: si cambia precio, IVA (tax_rate / prices_include_tax) o sku, cierra la versión vigente y abre la nueva.
CREATE OR REPLACE FUNCTION fecp_track_price() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     OR (NEW.price, NEW.tax_rate, NEW.prices_include_tax, NEW.sku) IS DISTINCT FROM (OLD.price, OLD.tax_rate, OLD.prices_include_tax, OLD.sku) THEN
    UPDATE product_price_history SET valid_to = now() WHERE product_id = NEW.id AND valid_to IS NULL;
    INSERT INTO product_price_history (product_id, sku, price, tax_rate, prices_include_tax, valid_from)
    VALUES (NEW.id, NEW.sku, NEW.price, NEW.tax_rate, NEW.prices_include_tax, now());
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_products_price_history ON products;
CREATE TRIGGER trg_products_price_history AFTER INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION fecp_track_price();

-- Revisión de precios en ventas de la caja. Una venta con diferencias se ACEPTA y se guarda (el cliente ya pagó), queda
-- 'pending' con el motivo en last_error, y NO se factura hasta que un admin la apruebe (o la anule con una nota).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_review_status     TEXT;        -- NULL | 'pendiente' | 'aprobada' | 'anulada'
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_review_detail     JSONB;       -- por línea: enviado, vigente y diferencia
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_review_at         TIMESTAMPTZ; -- desde cuándo está retenida
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_review_by         INTEGER REFERENCES users(id); -- admin que decidió
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_review_decided_at TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_review_note       TEXT;        -- motivo (obligatorio al anular)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS time_note               TEXT;        -- hora del equipo fuera de rango → se usó la del servidor
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_price_review_check;
ALTER TABLE sales ADD CONSTRAINT sales_price_review_check CHECK (price_review_status IS NULL OR price_review_status IN ('pendiente','aprobada','anulada'));
CREATE INDEX IF NOT EXISTS idx_sales_price_review ON sales (price_review_at) WHERE price_review_status = 'pendiente';

-- ============================================================================
-- Clientes sincronizados desde Siigo (Siigo → POS, una sola dirección). Todo idempotente.
-- ============================================================================
-- El POS acepta cualquier tipo de documento de la DIAN (2 dígitos) que traiga Siigo (antes solo 13, 31, 22 y 41).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_id_type_check' AND pg_get_constraintdef(oid) LIKE '%{2}%') THEN
    ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_id_type_check;
    ALTER TABLE customers ADD CONSTRAINT customers_id_type_check CHECK (id_type ~ '^[0-9]{2}$');
  END IF;
END $$;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS siigo_id TEXT;                          -- id (UUID) del tercero en Siigo
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active   BOOLEAN NOT NULL DEFAULT TRUE;  -- FALSE = inactivo en Siigo: no se ofrece en la caja
-- Texto de búsqueda por nombre: minúsculas y sin tildes (translate es inmutable, por eso puede ser columna generada)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS search_name TEXT
  GENERATED ALWAYS AS (translate(lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(company_name,'')), 'áéíóúüñ', 'aeiouun')) STORED;
CREATE INDEX IF NOT EXISTS idx_customers_siigo_id ON customers (siigo_id);
-- Búsqueda por identificación (prefijo: LIKE '123%' solo usa índice con text_pattern_ops)
CREATE INDEX IF NOT EXISTS idx_customers_ident_prefix ON customers (identification text_pattern_ops);
-- Búsqueda por nombre (contiene): índice trigram. pg_trgm viene con Postgres; si no se pudiera crear, la búsqueda funciona igual (más lenta).
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm no disponible: la búsqueda por nombre de clientes no usará índice';
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_customers_search_name ON customers USING gin (search_name gin_trgm_ops);
  END IF;
END $$;

-- Corridas de la sincronización. El índice único parcial es el BLOQUEO: solo puede haber UNA corrida 'running' a la vez
-- (aunque haya varios procesos). Si el proceso muere, la fila queda 'running' con el latido viejo: se puede retomar.
CREATE TABLE IF NOT EXISTS customer_sync_runs (
  id            SERIAL PRIMARY KEY,
  mode          TEXT NOT NULL,                          -- 'full' | 'incremental'
  status        TEXT NOT NULL DEFAULT 'running',        -- running | done | interrupted | cancelled
  phase         TEXT NOT NULL DEFAULT 'main',           -- full: main · incremental: updated y luego created
  next_page     INTEGER NOT NULL DEFAULT 1,             -- próxima página por procesar (para retomar)
  total_pages   INTEGER,
  total_results INTEGER,                                -- total que reporta Siigo en la fase actual
  since         DATE,                                   -- incremental: fecha desde la que se pide (con un día de traslape)
  started_by    INTEGER REFERENCES users(id),
  owner         TEXT,                                   -- quién tiene el bloqueo ahora (token del proceso)
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  requests      INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  unchanged     INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  duplicates    INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  skip_reasons  JSONB NOT NULL DEFAULT '{}'::jsonb,     -- solo conteos por motivo, nunca datos personales
  error_message TEXT
);
ALTER TABLE customer_sync_runs ADD COLUMN IF NOT EXISTS changes JSONB NOT NULL DEFAULT '{}'::jsonb; -- qué columnas cambiaron en los actualizados (solo conteos: {"email": 3, "address": 1})
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_sync_running ON customer_sync_runs ((TRUE)) WHERE status = 'running';

-- ============================================================================
-- Pago electrónico por INTENTOS. Cada vez que el cliente elige cómo pagar (QR o en pantalla) se abre un intento con su propia
-- referencia hacia ePayco (la 1.ª es el número de compra; las siguientes llevan sufijo: K01-000123-2). Todos son de la misma venta.
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_attempts (
  id            SERIAL PRIMARY KEY,
  sale_id       UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  attempt_no    INTEGER NOT NULL,
  invoice       TEXT NOT NULL,                  -- referencia (x_id_invoice) que se manda a ePayco en este intento
  channel       TEXT NOT NULL,                  -- 'pantalla' | 'qr'
  session_id    TEXT,
  -- abierto | pendiente | aprobado | rechazado | cancelado | vencido | reemplazado | por_revisar
  status        TEXT NOT NULL DEFAULT 'abierto',
  ref_payco     TEXT,                           -- referencia LARGA conocida (la trae el navegador o el webhook): permite la consulta activa
  reason        TEXT,                           -- motivo legible (sin datos de tarjeta)
  checks        INTEGER NOT NULL DEFAULT 0,     -- cuántas consultas activas a ePayco se hicieron
  last_check_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  UNIQUE (sale_id, attempt_no),
  UNIQUE (invoice)
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_open ON payment_attempts (status) WHERE status IN ('abierto','pendiente');
-- payment_refs: un pago cancelado por el cliente se anota aparte del rechazado por el banco
ALTER TABLE payment_refs DROP CONSTRAINT IF EXISTS payment_refs_outcome_check;
ALTER TABLE payment_refs ADD CONSTRAINT payment_refs_outcome_check CHECK (outcome IN ('procesando','aprobado','rechazado','cancelado','por_revisar','tardio','duplicado'));

-- Evidencia de pago en curso y QR abierto en un celular (ver src/lib/epayco/attempts.ts).
--   webhook_at:   llegó (y estaba firmado) cualquier aviso de ePayco con la referencia de este intento
--   qr_opened_at: se abrió la página /pagar/<código> en un celular para este intento
-- "Evidencia" = ref_payco conocido, estado pendiente en ePayco o aviso del webhook. Con evidencia el servidor NO deja abrir otro intento.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS webhook_at   TIMESTAMPTZ;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS qr_opened_at TIMESTAMPTZ;

-- Referencias que trae el WEBHOOK de ePayco. OJO: ninguna es la referencia LARGA (ref_payco, 24 hex) con la que se consulta a ePayco:
--   x_ref_payco = número corto ("Referencia Davipay", p. ej. 395055851); x_transaction_id = id del procesador (PSE: 18 dígitos; tarjeta: "103").
-- La larga solo llega por el NAVEGADOR (onResponse del checkout o la URL de retorno ?ref_payco=). Se guardan para el panel y la evidencia.
--   ref_used: con qué se confirmó el pago: larga | transaction_id | corta (estas dos solo con EPAYCO_ALT_REF_LOOKUP=true) | firma (aviso firmado:
--             EPAYCO_TRUST_SIGNED_WEBHOOK=true o "Facturar con evidencia del webhook" del admin)
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS x_ref_payco      TEXT;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS x_transaction_id TEXT;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS webhook_invoice  TEXT;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS ref_used         TEXT;
-- Resumen del ÚLTIMO aviso firmado (sin firma ni datos personales): referencias, invoice, extra1, monto, moneda, estado, franquicia, modo y fechas.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS webhook_summary     JSONB;
-- Cuándo llegó un aviso firmado de pago APROBADO (x_cod_response=1). Con esto el cobro NO vence como fallido: pasa a "por revisar".
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS webhook_approved_at TIMESTAMPTZ;
-- "Facturar con evidencia del webhook" (admin): quién, cuándo y la nota obligatoria
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS evidence_by   INTEGER;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS evidence_at   TIMESTAMPTZ;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS evidence_note TEXT;

-- ---------------------------------------------------------------------------
-- CATÁLOGO UNIFICADO WooCommerce + Siigo, y BODEGA de Siigo por usuario / venta
-- ---------------------------------------------------------------------------
-- products: llave de unión = código de Siigo = SKU de Woo (sin espacios, MAYÚSCULAS). origin dice de dónde viene cada producto.
--   woocommerce: solo en Woo · siigo: solo en Siigo (no tiene woo_id) · ambos: unidos por el código.
-- Reglas de propiedad: la sincronización de Woo nunca toca ni desactiva origin='siigo'; la de Siigo nunca pisa nombre, imagen,
-- categoría ni precio de un producto con woo_id (de esos solo agrega siigo_* y existencias).
ALTER TABLE products ALTER COLUMN woo_id DROP NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS origin        TEXT NOT NULL DEFAULT 'woocommerce';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_origin_check;
ALTER TABLE products ADD CONSTRAINT products_origin_check CHECK (origin IN ('woocommerce','siigo','ambos'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_id      TEXT;               -- id (UUID) del producto en Siigo
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_code    TEXT;               -- código TAL COMO está en Siigo (es el que va en la factura)
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_type    TEXT;               -- Product | Service | ...
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_active  BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_group   TEXT;               -- grupo de inventario (account_group)
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_name    TEXT;               -- lo que dice Siigo (para el reporte de diferencias y si el producto deja Woo)
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_price   NUMERIC(14,2);      -- precio de Siigo (lista configurada), informativo si el producto es de Woo
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_price_includes_tax BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_synced_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS siigo_ambiguous TEXT;             -- motivo si el código es repetido/ambiguo: NO se unió
ALTER TABLE products ADD COLUMN IF NOT EXISTS woo_seen_at   TIMESTAMPTZ;        -- última vez que Woo lo trajo (decide qué desactivar en la sync completa)
UPDATE products SET woo_seen_at = updated_at WHERE woo_seen_at IS NULL AND woo_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_siigo_id ON products (siigo_id) WHERE siigo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_sku_norm ON products (upper(regexp_replace(sku, '\s', '', 'g')));
CREATE INDEX IF NOT EXISTS idx_products_origin ON products (origin);

-- Bodegas de Siigo (última lista conocida: sirve si Siigo no responde). include_woo: en el catálogo de esa bodega, ¿se incluyen los de Woo?
CREATE TABLE IF NOT EXISTS warehouses (
  id          INTEGER PRIMARY KEY,           -- id de Siigo (GET /v1/warehouses); -1 = "Sin asignar" (solo existencias)
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  include_woo BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existencias por producto y bodega (INFORMATIVAS: el POS no bloquea ventas por inventario)
CREATE TABLE IF NOT EXISTS product_stock (
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL,
  quantity     NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_product_stock_wh ON product_stock (warehouse_id);

-- Bodega del usuario (NULL = usa la bodega por defecto de Configuración) y bodega elegida por un admin para su sesión de caja
ALTER TABLE users ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_warehouse_id INTEGER;
-- Historial de la bodega con la que podía vender cada usuario (asignación, cambio de sesión del admin). Una venta hecha sin conexión
-- con la bodega A se acepta aunque al llegar el usuario ya esté en B, si A era su bodega cuando se hizo la venta.
CREATE TABLE IF NOT EXISTS user_warehouse_log (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  warehouse_id INTEGER,                      -- NULL = sin bodega
  kind         TEXT NOT NULL,                -- asignada | sesion | defecto
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to     TIMESTAMPTZ,
  changed_by   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_uwl_user ON user_warehouse_log (user_id, valid_from);

-- La bodega con la que SE VENDIÓ queda en la venta; las reintentos y las ventas sin conexión facturan con ella, no con la asignación actual
ALTER TABLE sales ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS warehouse_name TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_warehouse ON sales (warehouse_id);

-- Corridas de la sincronización de productos de Siigo (progreso, resumen y candado visible)
CREATE TABLE IF NOT EXISTS product_sync_runs (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('completa','existencias')),
  trigger     TEXT NOT NULL DEFAULT 'manual',     -- manual | automatica
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  started_by  INTEGER,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  progress    JSONB,                              -- { page, pages, products }
  summary     JSONB,                              -- creados, actualizados, unidos, omitidos, ambiguos, errores...
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_psr_started ON product_sync_runs (started_at DESC);
