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
