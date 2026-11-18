"use client";

// Cobro DIVIDIDO: medios de pago de la venta. Una línea por medio (máx. 4). La caja muestra siempre "Falta por cubrir".
// Esta pantalla solo ayuda al cajero: el SERVIDOR vuelve a validar todo (src/lib/payment-lines.ts) con su propio total.
import { addDays, CREDIT_DAYS_OPTIONS, MAX_PAY_LINES } from "@/lib/payment-lines";
import { PAYMENT_METHODS, paymentShortLabel, type LineMethod } from "@/lib/payments";
import { round2 } from "@/lib/money";
import { formatMoney, missingOf, newLine, parseDigits, resolveAmounts, type LineUi } from "./payment-ui";

const QUICK_BILLS = [10000, 20000, 50000, 100000];
const SPLIT_ORDER: LineMethod[] = ["tarjeta", "transferencia", "efectivo", "credito_fecp"];

const inputCls =
  "w-full border border-field rounded-lg px-3 min-h-12 text-[16px] text-fg placeholder:text-[15px] placeholder:text-faint outline-none focus:border-brand bg-surface";
const labelCls = "block text-[13px] font-semibold text-body";

const dueText = (day: string) => {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
};

export default function PaymentLines({
  total,
  lines,
  setLines,
  epaycoReady,
  saleDay,
  autoFocus,
}: {
  total: number;
  lines: LineUi[];
  setLines: (fn: (prev: LineUi[]) => LineUi[]) => void;
  epaycoReady: boolean;
  /** hoy (Bogotá): para mostrar el vencimiento del crédito */
  saleDay: string;
  autoFocus: boolean;
}) {
  const amounts = resolveAmounts(lines, total);
  const falta = missingOf(lines, total);
  const isEpayco = lines.length === 1 && lines[0].method === "epayco";
  const split = lines.length > 1;
  const methodsIn = new Set(lines.map((l) => l.method));

  const patch = (key: number, p: Partial<LineUi>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));

  /** Una línea sola: el chip CAMBIA el medio (radio). En modo dividido: agrega o quita la línea (casillas). */
  function pick(m: LineMethod) {
    if (m === "epayco") {
      if (split) return; // el pago electrónico no se combina: se cobra solo
      setLines(() => [newLine("epayco")]);
      return;
    }
    if (!split) {
      if (lines[0].method === m) return;
      setLines(() => [newLine(m)]); // empieza limpia con el medio elegido (cubre el total)
      return;
    }
    if (methodsIn.has(m)) {
      setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.method !== m) : prev));
    } else if (lines.length < MAX_PAY_LINES) {
      setLines((prev) => [...prev, newLine(m)]);
    }
  }

  function startSplit() {
    const next = SPLIT_ORDER.find((m) => !methodsIn.has(m));
    if (!next) return;
    setLines((prev) => [...prev, newLine(next)]);
  }

  /** Completa una línea con lo que falta (por si se pasó a "fija" y quedó un faltante) */
  const fill = (key: number, current: number) => patch(key, { amount: round2(current + falta) });

  return (
    <div className="space-y-3">
      {/* ---------- Falta por cubrir (siempre visible) ---------- */}
      <div
        className={`rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 border ${
          isEpayco || Math.abs(falta) < 0.005 ? "bg-ok-soft border-ok-line text-ok-ink" : "bg-warn-soft border-warn-line text-warn-ink"
        }`}
        role="status"
        aria-live="polite"
      >
        <span className="text-[14px] font-semibold">{falta < -0.004 ? "Sobran" : "Falta por cubrir"}</span>
        <span className="text-2xl font-extrabold">{isEpayco ? formatMoney(0) : formatMoney(Math.abs(falta))}</span>
      </div>

      {/* ---------- Medios ---------- */}
      <div>
        <div className={`${labelCls} mb-1.5`}>{split ? "Medios de pago (toca para agregar o quitar)" : "Medio de pago"}</div>
        <div className="grid grid-cols-2 gap-2">
          {PAYMENT_METHODS.map((m) => {
            const selected = methodsIn.has(m.id);
            const off = (m.id === "epayco" && (!epaycoReady || split)) || (split && m.id !== "epayco" && !selected && lines.length >= MAX_PAY_LINES);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => pick(m.id)}
                disabled={off}
                aria-pressed={selected}
                title={
                  m.id === "epayco" && !epaycoReady
                    ? "No disponible: falta configurar ePayco"
                    : m.id === "epayco" && split
                      ? "El pago electrónico se cobra solo: quita los demás medios para usarlo"
                      : undefined
                }
                className={`min-h-12 px-2 rounded-lg border text-[14px] font-medium leading-tight disabled:opacity-50 disabled:cursor-not-allowed ${
                  selected ? "bg-brand border-brand text-white" : "bg-surface border-field text-body hover:bg-hover"
                } ${m.id === "epayco" || m.id === "transferencia" ? "col-span-2" : ""}`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        {!isEpayco && lines.length < MAX_PAY_LINES && (
          <button
            type="button"
            onClick={startSplit}
            className="mt-2 w-full min-h-11 rounded-lg border border-dashed border-brand text-brand-text bg-surface text-[14px] font-semibold hover:bg-brand-soft"
          >
            ＋ {split ? "Agregar otro medio" : "Dividir el pago en varios medios"}
          </button>
        )}
      </div>

      {/* ---------- Una tarjeta por línea ---------- */}
      {lines.map((l, i) => {
        const amt = amounts[i];
        const auto = l.amount === null;
        if (l.method === "epayco") {
          return (
            <div key={l.key} className="rounded-lg border border-brand-line bg-brand-soft px-3 py-3 text-[14px] text-brand-ink space-y-1">
              <div className="font-bold">Cobro con tarjeta, PSE, Nequi, QR, etc.</div>
              <div>
                Al confirmar, el cliente elige cómo pagar: con <b>QR en su celular</b> o <b>en esta pantalla</b>. La venta solo se factura cuando el servidor
                confirma el pago con ePayco; no hace falta digitar ninguna referencia. El pago electrónico es el <b>único</b> medio de la venta.
              </div>
            </div>
          );
        }
        const recv = l.cashStr ? parseDigits(l.cashStr) : amt;
        const change = round2(recv - amt);
        return (
          <div key={l.key} className="rounded-xl border border-line bg-surface p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[15px] font-bold text-fg">{paymentShortLabel(l.method)}</div>
              {split && (
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  className="w-11 h-11 rounded-lg text-xl leading-none text-dim hover:text-fg hover:bg-hover"
                  aria-label={`Quitar ${paymentShortLabel(l.method)}`}
                  title="Quitar este medio"
                >
                  ×
                </button>
              )}
            </div>

            {/* Monto aplicado (en efectivo: lo que se cobra de la venta; el billete entregado va abajo) */}
            <label className="block">
              <span className={labelCls}>
                {l.method === "efectivo" ? "Efectivo aplicado a la venta" : "Monto"}
                {auto && lines.length > 1 && <span className="ml-2 text-[12px] font-medium text-dim">(completa lo que falta)</span>}
              </span>
              <input
                className={`${inputCls} !text-xl font-bold`}
                inputMode="numeric"
                value={amt > 0 ? (Number.isInteger(amt) ? formatMoney(amt) : formatMoney(amt)) : ""}
                onChange={(e) => patch(l.key, { amount: parseDigits(e.target.value) })}
                placeholder="$ 0"
                readOnly={lines.length === 1}
                aria-label={`Monto de ${paymentShortLabel(l.method)}`}
              />
            </label>
            {!auto && falta > 0.004 && (
              <button type="button" onClick={() => fill(l.key, amt)} className="min-h-11 px-3 rounded-lg border border-brand text-brand-text text-[13px] font-semibold bg-surface hover:bg-brand-soft">
                Completar con lo que falta ({formatMoney(falta)})
              </button>
            )}

            {l.method === "efectivo" && (
              <div className="space-y-2">
                <label className="block">
                  <span className={labelCls}>Valor recibido (vacío = exacto)</span>
                  <input
                    className={`${inputCls} !text-xl font-bold`}
                    inputMode="numeric"
                    autoFocus={autoFocus && lines.length === 1}
                    value={l.cashStr ? formatMoney(parseDigits(l.cashStr)) : ""}
                    onChange={(e) => patch(l.key, { cashStr: e.target.value.replace(/\D/g, "") })}
                    placeholder="$ 0"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {QUICK_BILLS.map((b) => (
                    <button key={b} type="button" onClick={() => patch(l.key, { cashStr: String(b) })} className="min-h-12 rounded-lg border border-field bg-surface text-[14px] font-medium text-body hover:bg-hover">
                      {formatMoney(b)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => patch(l.key, { cashStr: "" })}
                    className={`min-h-12 rounded-lg border text-[14px] font-semibold ${l.cashStr === "" ? "bg-brand border-brand text-white" : "border-brand text-brand-text bg-surface hover:bg-brand-soft"}`}
                  >
                    Exacto
                  </button>
                </div>
                <div className={`rounded-xl text-center py-3 ${change >= 0 && amt > 0 ? "bg-ok-soft" : "bg-surface border border-line"}`}>
                  <div className="text-[13px] font-semibold text-body">{change < 0 ? "Faltan" : "Cambio"}</div>
                  <div className={`text-4xl sm:text-5xl font-extrabold ${change < 0 ? "text-err-ink" : "text-ok-ink"}`}>{formatMoney(Math.abs(change))}</div>
                </div>
              </div>
            )}

            {(l.method === "tarjeta" || l.method === "transferencia") && (
              <div className="space-y-3">
                <label className="block">
                  <span className={labelCls}>Referencia o últimos dígitos del comprobante</span>
                  <input
                    className={inputCls}
                    autoFocus={autoFocus && lines.length === 1}
                    maxLength={60}
                    inputMode="numeric"
                    value={l.reference}
                    onChange={(e) => patch(l.key, { reference: e.target.value })}
                    placeholder="Ej. 4821 o número de aprobación"
                  />
                </label>
                <label
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer text-[14px] text-fg ${
                    l.verified ? "bg-ok-soft border-ok-line" : "bg-surface border-warn-line"
                  }`}
                >
                  <input type="checkbox" className="mt-0.5 w-6 h-6 shrink-0" checked={l.verified} onChange={(e) => patch(l.key, { verified: e.target.checked })} />
                  <span>Verifiqué el pago en el datáfono o en la cuenta de FECP</span>
                </label>
              </div>
            )}

            {l.method === "credito_fecp" && (
              <div className="space-y-2">
                <div className={labelCls}>Plazo</div>
                <div className="grid grid-cols-4 gap-2" role="group" aria-label="Plazo del crédito">
                  {CREDIT_DAYS_OPTIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => patch(l.key, { days: d })}
                      aria-pressed={l.days === d}
                      className={`min-h-12 rounded-lg border text-[15px] font-semibold ${l.days === d ? "bg-brand border-brand text-white" : "bg-surface border-field text-body hover:bg-hover"}`}
                    >
                      {d} días
                    </button>
                  ))}
                </div>
                {l.days ? (
                  <p className="text-[14px] text-fg">
                    Vence el <b>{dueText(addDays(saleDay, l.days))}</b>
                  </p>
                ) : (
                  <p className="text-[13px] text-warn-ink">Elige el plazo del crédito.</p>
                )}
                <p className="text-[12px] text-dim">
                  El POS no lleva cupo ni abonos: el saldo se maneja en Siigo. Exige un cliente identificado con cédula o NIT y sus datos completos.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
