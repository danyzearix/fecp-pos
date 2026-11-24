import { formatCOP } from "@/lib/money";
import { paymentLabel, paymentShortLabel, type PosConfig, type TicketData } from "@/lib/sale-types";

const fmtDate = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

export const dianQrUrl = (cufe: string) => `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cufe}`;

function Row({ left, right, bold }: { left: React.ReactNode; right?: React.ReactNode; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontWeight: bold ? 700 : 400 }}>
      <span>{left}</span>
      {right !== undefined && <span style={{ whiteSpace: "nowrap" }}>{right}</span>}
    </div>
  );
}

const dueDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

const Sep = () => <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />;
const Center = ({ children, bold }: { children: React.ReactNode; bold?: boolean }) => (
  <div style={{ textAlign: "center", fontWeight: bold ? 700 : 400 }}>{children}</div>
);

/**
 * Tirilla de 80 mm (contenido de 72 mm).
 *  - status 'invoiced' → factura definitiva (con CUFE y QR si es electrónica).
 *  - cualquier otro estado → comprobante provisional.
 */
export default function TicketView({ data, config, qrDataUrl }: { data: TicketData; config: PosConfig; qrDataUrl?: string | null }) {
  const n = config.negocio;
  const test = config.testMode;
  const final = data.status === "invoiced" && !!data.invoice_name;
  const r = config.resolucion;

  return (
    <div
      style={{
        width: "72mm",
        margin: "0 auto",
        padding: "3mm 0",
        background: "#fff",
        color: "#000",
        fontFamily: "ui-monospace, 'Courier New', Consolas, monospace",
        fontSize: "11.5px",
        lineHeight: 1.35,
      }}
    >
      {test && <Center bold>*** PRUEBA – SIN VALIDEZ FISCAL ***</Center>}
      <Center bold>{n.nombre || "(configura NEGOCIO_NOMBRE)"}</Center>
      {n.nit && <Center>NIT {n.nit}</Center>}
      {n.direccion && <Center>{n.direccion}</Center>}
      {n.telefono && <Center>Tel. {n.telefono}</Center>}
      <Sep />

      {final ? (
        <>
          <Center bold>{test ? "FACTURA DE VENTA (DOCUMENTO DE PRUEBA)" : "FACTURA ELECTRÓNICA DE VENTA"}</Center>
          <Center bold>No. {data.invoice_name}</Center>
          {!test && (r.numero || r.fecha) && (
            <div style={{ fontSize: "10.5px", textAlign: "center", marginTop: 3 }}>
              Resolución DIAN {r.numero} del {r.fecha}
              {r.rango && <div>Rango autorizado: {r.rango}</div>}
              {r.vigencia && <div>Vigencia: {r.vigencia}</div>}
            </div>
          )}
        </>
      ) : (
        <Center bold>COMPROBANTE PROVISIONAL – NO ES FACTURA</Center>
      )}
      <Sep />

      <Row left={final ? "Venta" : "Número"} right={data.local_number} />
      <Row left="Fecha" right={fmtDate.format(new Date(data.created_at))} />
      <Row left="Cajero" right={data.cashier_name} />
      {data.warehouse_name && <Row left="Bodega" right={data.warehouse_name} />}
      <div>Cliente: {data.customer_name}</div>
      {/* El tipo de documento va en su propia línea, antes del número */}
      {data.customer_id_type && <div>{data.customer_id_type}</div>}
      <div>{data.customer_identification}</div>
      <Sep />

      {data.items.map((i, idx) => (
        <div key={idx} style={{ marginBottom: 3 }}>
          <div>{i.name}</div>
          <Row left={`  ${i.quantity} x ${formatCOP(i.unit_price)}`} right={formatCOP(i.line_total)} />
        </div>
      ))}
      <Sep />

      <Row left="Subtotal" right={formatCOP(data.subtotal)} />
      {data.tax_by_rate.map((t) => (
        <Row key={t.rate} left={`IVA ${t.rate}% (base ${formatCOP(t.base)})`} right={formatCOP(t.tax)} />
      ))}
      <Row left="TOTAL" right={formatCOP(data.total)} bold />
      <Sep />
      {/* Una entrada por línea de pago: monto aplicado y referencia; el cambio solo en la de efectivo; el plazo y vencimiento en el crédito */}
      {data.payments.length > 1 && <div style={{ fontWeight: 700 }}>FORMAS DE PAGO</div>}
      {data.payments.length === 1 && <div>Medio de pago: {paymentLabel(data.payments[0].method)}</div>}
      {data.payments.map((p, idx) => (
        <div key={idx} style={{ marginBottom: data.payments.length > 1 ? 2 : 0 }}>
          {data.payments.length > 1 && <Row left={paymentShortLabel(p.method)} right={formatCOP(p.amount)} />}
          {p.reference && <Row left={data.payments.length > 1 ? "  Ref." : "Referencia"} right={p.reference} />}
          {p.method === "efectivo" && p.cash_received != null && <Row left={data.payments.length > 1 ? "  Recibido" : "Recibido"} right={formatCOP(p.cash_received)} />}
          {p.method === "efectivo" && p.change_given != null && <Row left={data.payments.length > 1 ? "  Cambio" : "Cambio"} right={formatCOP(p.change_given)} />}
          {p.credit_days != null && <Row left="  Plazo" right={`${p.credit_days} días`} />}
          {p.due_date && <Row left="  Vence" right={dueDate(p.due_date)} />}
        </div>
      ))}
      <Sep />

      {final ? (
        data.cufe ? (
          <>
            <div style={{ fontWeight: 700 }}>CUFE:</div>
            <div style={{ wordBreak: "break-all", fontSize: "10.5px" }}>{data.cufe}</div>
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

      {final && (
        <>
          <Sep />
          <Center>
            Software: {config.software.nombre} – {config.software.fabricante}
          </Center>
        </>
      )}
      {test && (
        <>
          <Sep />
          <Center bold>*** PRUEBA – SIN VALIDEZ FISCAL ***</Center>
        </>
      )}
    </div>
  );
}
