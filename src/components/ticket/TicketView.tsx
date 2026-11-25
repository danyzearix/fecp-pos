import { LETRA_DE_CAMBIO, TICKET_LOGO_SRC, TICKET_LOGO_WIDTH_MM } from "@/config/ticket-text";
import { TICKET_DEFAULTS } from "@/lib/config";
import { formatCOP } from "@/lib/money";
import { ID_TYPE_TICKET_LABEL, paymentShortLabel, type PosConfig, type TicketData } from "@/lib/sale-types";

// ---------------------------------------------------------------------------------------------------------------------
// TIRILLA de 80 mm (contenido de 72 mm), con el orden y el contenido de la muestra de Siigo POS (FVP-18):
//  logo · nombre · NIT/dirección/teléfono · tipo de documento y número · cliente y vendedor · ítems con letra de impuesto ·
//  tabla de impuestos · totales · formas y métodos de pago · bodega · CUFE y QR · avisos legales.
// Nada de los datos del negocio está escrito aquí: sale de la configuración (NEGOCIO_*, RESOLUCION_DIAN_*, TICKET_*) o de Siigo.
// Siempre es blanco y negro (también en pantalla y en modo oscuro: es un papel).
// ---------------------------------------------------------------------------------------------------------------------

// El logo se pide ANTES de imprimir (así sale en la primera tirilla de la caja o del kiosco). Si no existe, no pasa nada.
if (typeof window !== "undefined") {
  const pre = new Image();
  pre.src = TICKET_LOGO_SRC;
}

export const dianQrUrl = (cufe: string) => `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cufe}`;

const TZ = "America/Bogota";
const fmtDateTime = (d: Date) =>
  new Intl.DateTimeFormat("es-CO", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d)
    .replace(", ", " ");
const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
};
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t === "" || t === "null" || t === "undefined" ? "" : t;
};

/** letras de impuesto de ESTA venta: A = la tarifa menor, B = la siguiente… (según las tarifas que de verdad hay en la venta) */
export function taxLetters(rates: number[]): Map<number, string> {
  const m = new Map<number, string>();
  [...new Set(rates)].sort((a, b) => a - b).forEach((r, i) => m.set(r, String.fromCharCode(65 + i)));
  return m;
}

/** "FV-1-25624" → prefijo "FV-1-" */
const invoicePrefix = (name: string) => /^(.*?)(\d+)$/.exec(name)?.[1] ?? "";

/** RESOLUCION_DIAN_RANGO: se toman los DOS últimos números ("1-50000", "FV-1 1 al 50000", "desde 1 hasta 50000"). null si no se puede leer. */
export function parseRange(r: string): { desde: string; hasta: string } | null {
  const nums = r.match(/\d+/g);
  return nums && nums.length >= 2 ? { desde: nums[nums.length - 2], hasta: nums[nums.length - 1] } : null;
}

const mono = "ui-monospace, 'Courier New', Consolas, monospace";
const Sep = () => <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />;
const Center = ({ children, bold, size }: { children: React.ReactNode; bold?: boolean; size?: number | string }) => (
  <div style={{ textAlign: "center", fontWeight: bold ? 700 : 400, fontSize: size }}>{children}</div>
);
function Row({ left, right, bold, size }: { left: React.ReactNode; right?: React.ReactNode; bold?: boolean; size?: number | string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontWeight: bold ? 700 : 400, fontSize: size }}>
      <span>{left}</span>
      {right !== undefined && <span style={{ whiteSpace: "nowrap" }}>{right}</span>}
    </div>
  );
}
/** Fila de tabla con columnas de ancho fijo (monoespaciada: las columnas quedan alineadas en la térmica) */
function Cols({ cells, widths, aligns, bold }: { cells: React.ReactNode[]; widths: string[]; aligns: ("left" | "right" | "center")[]; bold?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: widths.join(" "), columnGap: 3, fontWeight: bold ? 700 : 400 }}>
      {cells.map((c, i) => (
        <span key={i} style={{ textAlign: aligns[i], whiteSpace: "nowrap", overflow: "hidden" }}>{c}</span>
      ))}
    </div>
  );
}

/**
 * status 'invoiced' → factura definitiva (con CUFE y QR si es electrónica).
 * cualquier otro estado → comprobante provisional (sin número de factura, CUFE ni QR).
 */
export default function TicketView({ data, config, qrDataUrl }: { data: TicketData; config: PosConfig; qrDataUrl?: string | null }) {
  const n = config.negocio;
  const test = config.testMode;
  const final = data.status === "invoiced" && !!data.invoice_name;
  const r = config.resolucion;
  const t = config.tirilla ?? TICKET_DEFAULTS; // una configuración vieja guardada en el equipo no trae estos textos
  const letters = taxLetters(data.tax_by_rate.map((x) => x.rate).concat(data.items.map((i) => i.tax_rate)));
  const rateLabel = (rate: number) => `IVA ${rate}%`;
  const isCF = data.customer_identification === "222222222222" && /consumidor/i.test(data.customer_name);
  const idLabel = ID_TYPE_TICKET_LABEL[data.customer_id_code ?? ""] ?? (clean(data.customer_id_type) ? `${clean(data.customer_id_type)}:` : "Documento:");
  const dv = clean(data.customer_check_digit);
  const address = clean(data.customer_address), phone = clean(data.customer_phone);
  const credit = data.payments.find((p) => p.method === "credito_fecp");
  const totalUnits = data.items.reduce((a, i) => a + i.quantity, 0);
  const created = new Date(data.created_at);
  const prefix = data.invoice_name ? invoicePrefix(data.invoice_name) : "";
  const range = parseRange(r.rango);

  return (
    <div
      className="ticket-80"
      style={{
        width: "72mm",
        margin: "0 auto",
        padding: "3mm 0",
        background: "#fff",
        color: "#000",
        fontFamily: mono,
        fontSize: "11.5px",
        lineHeight: 1.35,
      }}
    >
      {test && <Center bold>*** PRUEBA – SIN VALIDEZ FISCAL ***</Center>}

      {/* a) logo centrado, en blanco y negro; si el archivo no existe no se muestra nada (y no se rompe) */}
      <div style={{ textAlign: "center", marginBottom: 3 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={TICKET_LOGO_SRC}
          alt=""
          data-ticket-logo="1"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
          style={{ width: `${TICKET_LOGO_WIDTH_MM}mm`, height: "auto", display: "inline-block", filter: "grayscale(1) contrast(1.6)", background: "#fff" }}
        />
      </div>

      {/* b) y c) encabezado: nombre (sale de NEGOCIO_NOMBRE), NIT con DV, dirección, ciudad y teléfono (NEGOCIO_*) */}
      <Center bold size="12.5px">{(n.nombre || "(configura NEGOCIO_NOMBRE)").toUpperCase()}</Center>
      {n.nit && <Center>NIT {n.nit}</Center>}
      {n.direccion && <Center>{n.direccion}</Center>}
      {n.telefono && <Center>Teléfono: {n.telefono}</Center>}
      <Sep />

      {/* d) tipo de documento, número y fechas */}
      {final ? (
        <>
          <Center bold>{test ? "Factura de venta (documento de prueba)" : "Factura electrónica de venta"}</Center>
          <Center bold>No. {data.invoice_name}</Center>
          <Row left="Fecha generación:" right={fmtDateTime(created)} size="10.5px" />
          <Row
            left="Fecha expedición:"
            right={data.invoice_created ? fmtDateTime(new Date(data.invoice_created)) : data.invoice_date ? fmtDay(data.invoice_date) : fmtDateTime(created)}
            size="10.5px"
          />
          <Row left="Venta:" right={data.local_number} size="10.5px" />
        </>
      ) : (
        <>
          <Center bold>Comprobante provisional - no es factura</Center>
          <Row left="Número:" right={data.local_number} size="10.5px" />
          <Row left="Fecha generación:" right={fmtDateTime(created)} size="10.5px" />
        </>
      )}
      <Sep />

      {/* e) cliente: nombre, tipo y número de documento (etiqueta según el tipo real), dirección, teléfono y vendedor */}
      {isCF ? (
        <>
          <div>Cliente: Consumidor final</div>
          <div>Documento: 222222222222</div>
        </>
      ) : (
        <>
          <div>Cliente: {data.customer_name}</div>
          <div>
            {idLabel} {data.customer_identification}
            {dv && data.customer_id_code === "31" && !data.customer_identification.includes("-") ? `-${dv}` : ""}
          </div>
          {address && <div>Dirección: {address}</div>}
          {phone && <div>Teléfono: {phone}</div>}
        </>
      )}
      <div>Vendedor: {data.cashier_name}</div>
      <Sep />

      {/* f) ítems: Ít., Cant., Vr. Unit, Valor, ID de impuesto; debajo, "nombre / código" */}
      <Cols widths={["3ch", "5ch", "1fr", "1fr", "3ch"]} aligns={["left", "right", "right", "right", "center"]} cells={["Ít.", "Cant.", "Vr. Unit", "Valor", "ID"]} bold />
      {data.items.map((i, idx) => (
        <div key={idx} style={{ marginTop: 2 }}>
          <Cols
            widths={["3ch", "5ch", "1fr", "1fr", "3ch"]}
            aligns={["left", "right", "right", "right", "center"]}
            cells={[String(idx + 1), num(i.quantity), formatCOP(i.unit_price), formatCOP(i.line_total), letters.get(i.tax_rate) ?? ""]}
          />
          <div style={{ fontSize: "10.5px", wordBreak: "break-word" }}>
            {i.name}
            {clean(i.code) ? ` / ${clean(i.code)}` : ""}
          </div>
        </div>
      ))}
      <Sep />

      {/* g) impuestos por tarifa real de la venta, con su leyenda */}
      <Cols widths={["3ch", "5ch", "1fr", "1fr"]} aligns={["left", "right", "right", "right"]} cells={["ID", "%", "Base", "Impuesto"]} bold />
      {data.tax_by_rate.map((x) => (
        <Cols key={x.rate} widths={["3ch", "5ch", "1fr", "1fr"]} aligns={["left", "right", "right", "right"]} cells={[letters.get(x.rate) ?? "", `${x.rate}%`, formatCOP(x.base), formatCOP(x.tax)]} />
      ))}
      <div style={{ fontSize: "10px" }}>{data.tax_by_rate.map((x) => `${letters.get(x.rate)}=${rateLabel(x.rate)}`).join(", ")}</div>
      <Sep />

      {/* h) totales */}
      <Row left="Total ítems" right={num(totalUnits)} />
      <Row left="Total bruto" right={formatCOP(data.subtotal)} />
      <Row left="Descuentos" right={formatCOP(0)} />
      <Row left="Subtotal" right={formatCOP(data.subtotal)} />
      {data.tax_by_rate.map((x) => (
        <Row key={x.rate} left={rateLabel(x.rate)} right={formatCOP(x.tax)} />
      ))}
      <div style={{ borderTop: "1px solid #000", margin: "3px 0" }} />
      <Row left="Total a pagar" right={formatCOP(data.total)} bold size="15px" />
      <Sep />

      {/* i) forma de pago (Contado / Crédito con vencimiento AAAA-MM-DD) y un renglón por método con su valor */}
      <div>
        <b>Forma de pago:</b> {credit?.due_date ? `Crédito (vence ${credit.due_date})` : "Contado"}
      </div>
      <div style={{ fontWeight: 700, marginTop: 2 }}>Métodos de pago</div>
      {data.payments.map((p, idx) => (
        <div key={idx} style={{ marginBottom: 2 }}>
          <Row left={paymentShortLabel(p.method)} right={formatCOP(p.amount)} />
          {clean(p.reference) && <Row left="  Ref." right={clean(p.reference)} size="10.5px" />}
          {p.method === "efectivo" && p.cash_received != null && <Row left="  Recibido" right={formatCOP(p.cash_received)} size="10.5px" />}
          {p.method === "efectivo" && p.change_given != null && <Row left="  Cambio" right={formatCOP(p.change_given)} size="10.5px" />}
          {p.credit_days != null && <Row left="  Plazo" right={`${p.credit_days} días`} size="10.5px" />}
        </div>
      ))}

      {/* j) bodega, discreta */}
      {clean(data.warehouse_name) && <div style={{ fontSize: "9.5px", marginTop: 3 }}>Bodega: {clean(data.warehouse_name)}</div>}
      <Sep />

      {/* k) CUFE completo y QR de la DIAN (solo en la factura emitida) */}
      {final ? (
        data.cufe ? (
          <>
            <div style={{ fontWeight: 700 }}>CUFE:</div>
            <div style={{ wordBreak: "break-all", fontSize: "10px" }}>{data.cufe}</div>
            {qrDataUrl && (
              <div style={{ textAlign: "center", marginTop: 6 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrDataUrl} alt="QR DIAN" style={{ width: "36mm", height: "36mm", display: "inline-block" }} />
              </div>
            )}
          </>
        ) : (
          <Center>Documento de prueba no electrónico: sin CUFE</Center>
        )
      ) : (
        <Center>La factura electrónica se emitirá al restablecer la conexión</Center>
      )}

      {/* l) avisos legales al pie: centrados y en letra pequeña. Régimen, actividad, resolución y software salen de variables. */}
      <Sep />
      <div style={{ textAlign: "center", fontSize: "9px", lineHeight: 1.3 }}>
        <div>
          {t.regimen}
          {t.actividad ? ` - Actividad económica ${t.actividad}` : ""}.
        </div>
        {final && (
          <>
            <div style={{ marginTop: 3 }}>{LETRA_DE_CAMBIO}</div>
            {!test && r.numero && (
              <div style={{ marginTop: 3 }}>
                Número Autorización {r.numero}
                {r.fecha ? ` aprobado en ${r.fecha}` : ""}
                {prefix ? ` prefijo ${prefix}` : ""}
                {range ? ` desde el número ${range.desde} al ${range.hasta}` : r.rango ? ` rango ${r.rango}` : ""}
                {r.vigencia ? ` Vigencia: ${r.vigencia}` : ""}
              </div>
            )}
            <div style={{ marginTop: 3 }}>
              Fabricante de software y proveedor tecnológico: {t.proveedorSoftware}. Nombre del software: {t.nombreSoftware}. Firma electrónica: relacionado en el XML.
            </div>
          </>
        )}
        <div style={{ marginTop: 3 }}>
          POS: {config.software.nombre} – {config.software.fabricante}
        </div>
      </div>
      {test && (
        <>
          <Sep />
          <Center bold>*** PRUEBA – SIN VALIDEZ FISCAL ***</Center>
        </>
      )}
    </div>
  );
}
