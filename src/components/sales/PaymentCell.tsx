"use client";

// Medio de pago de una venta en el historial. Una sola línea: "Tarjeta · Ref. 4821". Varias: "Mixto" con el detalle desplegable.
import { formatCOP } from "@/lib/money";
import { paymentLabel, paymentShortLabel } from "@/lib/payments";
import type { SaleListRow } from "@/lib/sales";

const dueText = (day: string) => {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
};

type Line = SaleListRow["payments"][number];

function LineDetail({ l, showAmount }: { l: Line; showAmount: boolean }) {
  return (
    <>
      {showAmount && (
        <>
          <b>{paymentShortLabel(l.method)}</b> {formatCOP(l.amount)}
        </>
      )}
      {l.reference && <span> · Ref. {l.reference}</span>}
      {l.method === "efectivo" && l.change_given != null && l.change_given > 0 && <span> · cambio {formatCOP(l.change_given)}</span>}
      {l.credit_days != null && (
        <span>
          {" "}
          · {l.credit_days} días{l.due_date ? `, vence ${dueText(l.due_date)}` : ""}
        </span>
      )}
    </>
  );
}

export default function PaymentCell({ s }: { s: SaleListRow }) {
  const lines = s.payments;
  if (lines.length > 1) {
    return (
      <details className="text-fg">
        <summary className="cursor-pointer leading-tight font-medium min-h-6">Mixto ({lines.length})</summary>
        <ul className="mt-1 space-y-0.5 text-[12px] text-body">
          {lines.map((l) => (
            <li key={l.method}>
              <LineDetail l={l} showAmount />
            </li>
          ))}
        </ul>
      </details>
    );
  }
  const l = lines[0];
  return (
    <div>
      {/* Las ventas viejas conservan su etiqueta original ("Tarjeta débito", "Tarjeta crédito") */}
      <div className="leading-tight">{paymentLabel(s.payment_method)}</div>
      {l && (l.reference || l.credit_days != null) && (
        <div className="text-[12px] text-dim">
          <LineDetail l={l} showAmount={false} />
        </div>
      )}
    </div>
  );
}
