import { CREDITO_SIIGO_PAYMENT_ID_DEFAULT, EPAYCO_SIIGO_PAYMENT_ID_DEFAULT, SIIGO_COST_CENTER, SIIGO_EXEMPT_TAX_ID, SIIGO_TAX_ID_BY_RATE } from "@/config/siigo-map";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { priceHistoryHours } from "@/lib/price-check";
import { reviewCounts } from "@/lib/price-review";
import { heldText } from "@/lib/price-review-rules";
import { creditInvoicingBlocker, epaycoInvoicingBlocker, explicitCreditPaymentId, siigoPaymentId } from "@/lib/siigo/payment";
import { requirePage } from "@/lib/auth";
import { getPosConfig } from "@/lib/config";
import { query } from "@/lib/db";
import { LEGACY_PAYMENT_METHODS, PAYMENT_METHODS } from "@/lib/payments";
import { sweepStuckInvoicing } from "@/lib/siigo/invoice";
import { formatCOP } from "@/lib/money";
import ConnectionTests from "./ConnectionTests";
import ProblemSales, { type Problem } from "./ProblemSales";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Configuración" };

// Solo lectura. Los secretos NUNCA se muestran: solo si están definidos.
const env = (k: string) => process.env[k] ?? "";
const secret = (k: string) => (env(k) ? "✓ definido" : "✗ FALTA");

function Section({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section className="bg-surface rounded-xl border border-line p-4">
      <h2 className="font-semibold text-fg mb-2">{title}</h2>
      <dl className="text-[14px] grid grid-cols-[minmax(0,210px)_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-dim">{k}</dt>
            <dd className={`text-fg break-words ${v.startsWith("✗") ? "text-err-ink font-semibold" : ""}`}>{v || "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default async function ConfiguracionPage() {
  await requirePage("/admin");
  await sweepStuckInvoicing().catch(() => {});
  const cfg = getPosConfig();
  const epayco = getEpaycoConfig();
  const invoicingBlocker = epaycoInvoicingBlocker();
  const creditBlocker = creditInvoicingBlocker();
  const rc = await reviewCounts();

  const probs = await query<Problem & { created_at: Date }>(
    `SELECT s.id, s.local_number, s.status, s.total::float8 AS total, u.name AS cashier,
            COALESCE(s.created_at_device, s.created_at) AS created_at, s.last_error
       FROM sales s JOIN users u ON u.id = s.cashier_id
      WHERE s.status IN ('pending','failed','revisar','invoicing','pagado','pago_por_revisar','pago_tardio')
      ORDER BY COALESCE(s.created_at_device, s.created_at) DESC LIMIT 200`
  );
  const problems: Problem[] = probs.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));

  return (
    <div className="space-y-6 max-w-6xl min-w-0">
      <h1 className="text-2xl font-bold text-fg">Configuración</h1>

      {cfg.testMode ? (
        <div className="rounded-xl border border-brand-line bg-brand-soft px-4 py-3 text-[14px] text-brand-ink">
          <b>MODO PRUEBA</b> (SIIGO_TEST_MODE=true): las ventas crean un documento NO electrónico (comprobante {env("SIIGO_TEST_DOCUMENT_ID") || "?"}),
          sin enviar a la DIAN. Los documentos quedan en Siigo con “PRUEBA POS - ELIMINAR”: <code>npm run siigo:pruebas</code> los lista.
        </div>
      ) : (
        <div className="rounded-xl border-2 border-err-line bg-err-soft px-4 py-3 text-[15px] text-err-ink">
          <b>⚠ MODO REAL (SIIGO_TEST_MODE=false):</b> cada venta genera una <b>factura electrónica real</b> y se envía a la DIAN
          (comprobante {env("SIIGO_DOCUMENT_ID") || "?"}). Una factura aceptada no se puede borrar, solo anular con nota crédito.
        </div>
      )}

      <section className="bg-surface rounded-xl border border-line p-4 space-y-3">
        <h2 className="font-semibold text-fg">Probar conexiones</h2>
        <ConnectionTests />
      </section>

      <section className="bg-surface rounded-xl border border-line p-4 space-y-3">
        <h2 className="font-semibold text-fg">Ventas pendientes o fallidas ({problems.length})</h2>
        <p className="text-[13px] text-dim">
          Una venta “Facturando” por más de 10 minutos pasa sola a “Por revisar”. “Por revisar” solo se VERIFICA en Siigo (nunca se reintenta a ciegas).
        </p>
        <ProblemSales rows={problems} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="WooCommerce"
          rows={[
            ["WOO_URL", env("WOO_URL")],
            ["WOO_CONSUMER_KEY", secret("WOO_CONSUMER_KEY")],
            ["WOO_CONSUMER_SECRET", secret("WOO_CONSUMER_SECRET")],
          ]}
        />
        <Section
          title="Siigo"
          rows={[
            ["SIIGO_USERNAME", secret("SIIGO_USERNAME")],
            ["SIIGO_ACCESS_KEY", secret("SIIGO_ACCESS_KEY")],
            ["SIIGO_PARTNER_ID", env("SIIGO_PARTNER_ID")],
            ["SIIGO_TEST_MODE", String(cfg.testMode)],
            ["SIIGO_DOCUMENT_ID (real)", env("SIIGO_DOCUMENT_ID")],
            ["SIIGO_TEST_DOCUMENT_ID", env("SIIGO_TEST_DOCUMENT_ID")],
            ["SIIGO_SELLER_ID (por defecto)", env("SIIGO_SELLER_ID")],
            ["Centro de costo", String(SIIGO_COST_CENTER)],
          ]}
        />
        <Section
          title="Mapa de impuestos → Siigo (src/config/siigo-map.ts)"
          rows={[
            ...Object.entries(SIIGO_TAX_ID_BY_RATE).map(([rate, id]) => [`IVA ${rate}%`, `id ${id}`] as [string, string]),
            ["IVA 0% (exento)", `id ${SIIGO_EXEMPT_TAX_ID}`],
            ["Excluido", "sin arreglo taxes"],
          ]}
        />
        <Section
          title="Mapa de medios de pago → Siigo"
          rows={[
            ...PAYMENT_METHODS.map((m) => {
              const note =
                m.id === "transferencia" ? " (valor de pruebas, pendiente de confirmar con FECP)"
                : m.id === "epayco" ? (env("EPAYCO_SIIGO_PAYMENT_ID") ? " (EPAYCO_SIIGO_PAYMENT_ID)" : " (por defecto: solo pruebas)")
                : m.id === "credito_fecp" ? (explicitCreditPaymentId() ? " (SIIGO_PAYMENT_CREDITO_ID)" : " (por defecto: solo pruebas)")
                : "";
              // En modo real, un valor "por defecto: solo pruebas" NO se usa: el sistema se niega a facturar ese medio
              const missingInReal = !cfg.testMode && ((m.id === "epayco" && !env("EPAYCO_SIIGO_PAYMENT_ID")) || (m.id === "credito_fecp" && !explicitCreditPaymentId()));
              return [m.label, missingInReal ? "✗ FALTA el id real (en modo real no se factura este medio)" : `id ${siigoPaymentId(m.id)}${note}`] as [string, string];
            }),
            ...LEGACY_PAYMENT_METHODS.map((m) => [`${m.label} (histórico)`, `id ${siigoPaymentId(m.id)}`] as [string, string]),
          ]}
        />
        <Section
          title="Validación de precios (caja)"
          rows={[
            ["PRICE_HISTORY_HOURS", `${priceHistoryHours()} horas${env("PRICE_HISTORY_HOURS") ? "" : " (por defecto)"}`],
            ["Regla", "Una línea es válida si coincide con el precio, IVA y SKU vigentes, o con alguno vigente en esa ventana. Tolerancia cero."],
            ["Ventas por revisar", rc.prices === 0 ? "0" : `${rc.prices} (${formatCOP(rc.pricesTotal)}) — la más antigua lleva ${heldText(rc.pricesOldestMin)}${rc.pricesLevel === "critica" ? " · ✗ MUY ATRASADA (+4 h)" : rc.pricesLevel === "atrasada" ? " · ATRASADA (+2 h)" : ""}`],
            ["Hora del equipo", "Se acepta entre hace 7 días y ahora + 5 minutos; fuera de eso se usa la hora del servidor y se anota"],
          ]}
        />
        <Section
          title="Crédito FECP"
          rows={[
            ["SIIGO_PAYMENT_CREDITO_ID", env("SIIGO_PAYMENT_CREDITO_ID") || (cfg.testMode ? `(sin definir: se usa ${CREDITO_SIIGO_PAYMENT_ID_DEFAULT}, solo de pruebas)` : "✗ FALTA (en modo real no se factura el crédito)")],
            ["¿Se pueden facturar ventas a crédito?", creditBlocker ? `✗ NO: ${creditBlocker}` : "Sí"],
            ["Plazos", "14, 30, 60 y 90 días (el vencimiento = fecha de la venta + plazo)"],
            ["Saldos y abonos", "El POS no los lleva: quedan en Siigo"],
          ]}
        />
        <Section
          title="Autoservicio / ePayco"
          rows={[
            ["EPAYCO_PUBLIC_KEY", secret("EPAYCO_PUBLIC_KEY")],
            ["EPAYCO_PRIVATE_KEY", secret("EPAYCO_PRIVATE_KEY")],
            ["EPAYCO_P_CUST_ID_CLIENTE", secret("EPAYCO_P_CUST_ID_CLIENTE")],
            ["EPAYCO_P_KEY", secret("EPAYCO_P_KEY")],
            ["EPAYCO_TEST_MODE", String(epayco.testMode)],
            ["Modo", epayco.publicBaseUrl ? `con dominio público (${epayco.publicBaseUrl}): webhook ACTIVO, QR de pago en la caja` : "local (APP_PUBLIC_URL vacío): webhook APAGADO y sin QR. Las páginas /pagar/<código> están activas pero solo se alcanzan desde esta red"],
            ["EPAYCO_SIIGO_PAYMENT_ID", env("EPAYCO_SIIGO_PAYMENT_ID") || (cfg.testMode ? `(sin definir: se usa ${EPAYCO_SIIGO_PAYMENT_ID_DEFAULT}, solo de pruebas)` : "✗ FALTA (en modo real no se factura)")],
            ["¿Se puede facturar pago electrónico?", invoicingBlocker ? `✗ NO: ${invoicingBlocker}` : "Sí"],
            ["KIOSCO_IMPRESORA", env("KIOSCO_IMPRESORA") || "false"],
          ]}
        />
        <Section
          title="Punto de venta"
          rows={[
            ["Prefijo de caja", cfg.prefix],
            ["UVT_VALUE", String(cfg.uvt)],
            ["5 UVT (base sin IVA)", String(5 * cfg.uvt)],
            [
              "CONSUMIDOR_FINAL_SIN_TOPE",
              cfg.consumidorFinalSinTope ? "true — Consumidor final sin tope de monto" : "false — por encima de 5 UVT se debe identificar al cliente",
            ],
            ["POS_ADDRESS", env("POS_ADDRESS") || "✗ FALTA"],
            ["POS_STATE_CODE / POS_CITY_CODE", `${cfg.defaultStateCode} / ${cfg.defaultCityCode}`],
            ["COOKIE_SECURE", env("COOKIE_SECURE") || "false"],
          ]}
        />
        <Section
          title="Negocio y resolución DIAN (tirilla)"
          rows={[
            ["Nombre", cfg.negocio.nombre || "✗ FALTA"],
            ["NIT", cfg.negocio.nit || "✗ FALTA"],
            ["Dirección", cfg.negocio.direccion || "✗ FALTA"],
            ["Teléfono", cfg.negocio.telefono],
            ["Resolución número", cfg.resolucion.numero || "✗ FALTA"],
            ["Resolución fecha", cfg.resolucion.fecha || "✗ FALTA"],
            ["Rango autorizado", cfg.resolucion.rango || "✗ FALTA"],
            ["Vigencia", cfg.resolucion.vigencia || "✗ FALTA"],
            ["Software", `${cfg.software.nombre} – ${cfg.software.fabricante}`],
          ]}
        />
      </div>
      <p className="text-[12px] text-dim">Para cambiar estos valores edita .env.local y reinicia el servidor.</p>
    </div>
  );
}
