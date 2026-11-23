"use client";

// Cobro con ePayco desde la CAJA. Usa los MISMOS componentes, endpoints y verificación que el kiosco (useEpaycoPayment + PayViews):
// el navegador solo manda productos y cantidades; el servidor calcula el total, abre cada intento de pago, consulta a ePayco,
// verifica monto/firma y factura. Lo que reporte ePayco al navegador (hooks / ref_payco) es solo una PISTA.
// Primero el cajero elige "Mostrar QR al cliente" o "Cobrar en esta pantalla"; hasta entonces no se crea ninguna sesión de ePayco.
import { useEffect, useRef, useState } from "react";
import { CancelledView, InProcessView, NoConfirmationView, PayChoice, QrScan, RejectedView, Spinner, VerifyingView } from "@/components/epayco/PayViews";
import { useEpaycoPayment, type CreateResult, type PayChannel, type PaySale } from "@/components/epayco/useEpaycoPayment";
import { printTicket } from "@/lib/client/print";
import { formatCOP, type CartLine } from "@/lib/money";
import type { CheckoutResult } from "./CheckoutModal";

export type { PayChannel };
export type EpaycoSale = PaySale;
export type EpaycoStart =
  | { mode: "new"; cart: CartLine[]; result: CheckoutResult; total: number }
  | { mode: "resume"; sale: EpaycoSale; ref: string | null };

const json = { "Content-Type": "application/json" };

// La venta en curso se guarda en este navegador: si ePayco recarga la página al terminar (/caja?ref_payco=...) se retoma.
const STORE_KEY = "fecp_caja_epayco_v1";
/** Venta de ePayco que quedó en curso en este navegador (null si no hay o ya es muy vieja). */
export function loadStoredSale(): EpaycoSale | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as EpaycoSale;
    if (!s?.id || new Date(s.expiresAt).getTime() < Date.now() - 30 * 60_000) {
      localStorage.removeItem(STORE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export default function EpaycoCharge({
  start,
  qrAvailable,
  onFinished,
  onClose,
}: {
  start: EpaycoStart;
  /** ¿hay dominio público (APP_PUBLIC_URL)? Sin él no existe el pago con QR */
  qrAvailable: boolean;
  /** El pago quedó recibido (facturado o por revisar): hay que vaciar el carrito */
  onFinished: () => void;
  /** Volver a la caja SIN vaciar el carrito (no se pagó o se canceló) */
  onClose: () => void;
}) {
  const [onLocalhost] = useState(() => typeof location !== "undefined" && location.hostname === "localhost");
  const [askCancel, setAskCancel] = useState(false);
  const [manualRef, setManualRef] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function createSale(channel: PayChannel): Promise<CreateResult> {
    if (start.mode !== "new") return { ok: false, error: "No hay una compra para cobrar." };
    try {
      const { cart, result } = start;
      const res = await fetch("/api/kiosco/pagos", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          // El navegador SOLO manda productos y cantidades: el servidor calcula precios, IVA y total desde su base de datos
          items: cart.map((l) => ({ product_id: l.productId, quantity: l.qty })),
          checkout_type: result.checkoutType,
          customer: result.customer,
          notify_email: result.customer?.email || undefined,
          channel,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: d.error ?? "No se pudo iniciar el cobro. Intente de nuevo." };
      return {
        ok: true,
        sale: {
          id: d.sale_id, local: d.local_number, total: d.total, sessionId: d.session_id ?? null, expiresAt: d.expires_at, test: !!d.test,
          payUrl: d.pay_url ?? null, channel: d.channel === "qr" ? "qr" : "pantalla", qrAvailable: !!d.qr_available, attempt: 1,
        },
      };
    } catch {
      return { ok: false, error: "No se pudo conectar con el servidor. Intente de nuevo." };
    }
  }

  const pay = useEpaycoPayment({
    storeKey: STORE_KEY,
    createSale,
    expectedTotal: start.mode === "new" ? start.total : undefined,
    resume: start.mode === "resume" ? { sale: start.sale, ref: start.ref } : null,
    onInvoiced: (id) => printTicket(id),
  });
  const { phase, sale } = pay;

  const finished = useRef(false);
  // Si el modal se cierra (o la caja empieza otra venta) con un cobro rechazado/cancelado/sin elegir de nuevo, el cobro se cancela en el
  // servidor: no queda abierto. (Además, el servidor cancela solo los cobros abandonados y vence los que pasan de 10 minutos.)
  const live = useRef<{ id: string | null; phase: string }>({ id: null, phase: "choose" });
  useEffect(() => {
    live.current = { id: sale?.id ?? null, phase };
  });
  useEffect(
    () => () => {
      const { id, phase: ph } = live.current;
      if (id && ["choose", "cancelled", "rejected", "expired"].includes(ph)) {
        void fetch(`/api/kiosco/pagos/${id}/cancelar`, { method: "POST", headers: json, body: "{}", keepalive: true }).catch(() => {});
      }
    },
    []
  );

  async function cancelPurchase() {
    const r = await pay.cancel();
    if (r.keptForReview && sale) {
      setNote(`La compra ${sale.local} quedó registrada para revisión: si el cliente ya pagó, no se perderá. Un administrador la ve en "Pagos por revisar". No cobre de nuevo.`);
      return;
    }
    onClose();
  }

  const done = () => {
    if (finished.current) return;
    finished.current = true;
    onFinished();
  };

  const cancelBar = (
    <div className="flex flex-wrap gap-3 justify-center pt-1">
      {!(askCancel && (phase === "window" || phase === "qr")) ? (
        <button onClick={() => setAskCancel(true)} className="min-h-11 px-5 rounded-lg border border-field text-[14px] font-medium text-body">
          Cancelar cobro
        </button>
      ) : (
        <div className="w-full rounded-lg border border-err-line bg-err-soft px-3 py-3 text-[13px] text-err-ink">
          Si el cliente ya pagó, NO cancele: espere la confirmación. ¿Cancelar el cobro?
          <div className="flex gap-3 justify-center pt-2">
            <button onClick={() => setAskCancel(false)} className="min-h-11 px-4 rounded-lg border border-field bg-surface text-body font-medium">
              No, seguir esperando
            </button>
            <button onClick={() => void cancelPurchase()} className="min-h-11 px-4 rounded-lg bg-err text-white font-bold">
              Sí, cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );

  /** Respaldo: el cajero pega la referencia larga (o el enlace de ePayco que la contiene) y el servidor la verifica. */
  const manual = (
    <details className="text-left rounded-lg border border-line bg-subtle px-3 py-2 text-[13px]">
      <summary className="cursor-pointer min-h-11 flex items-center font-semibold text-body">¿El cliente ya pagó y no avanza?</summary>
      <div className="pt-2 space-y-2">
        <p className="text-dim">
          Pegue aquí el enlace que muestra ePayco al terminar (el que contiene <b>ref_payco=</b>) o la referencia larga. El servidor la verifica con ePayco: no se confía en lo que digite.
        </p>
        <input
          value={manualRef}
          onChange={(e) => setManualRef(e.target.value)}
          placeholder="https://…landingresume?ref_payco=…"
          className="w-full border border-field rounded-lg px-3 py-2 min-h-11 text-[14px] text-fg outline-none focus:border-brand bg-surface"
        />
        <button onClick={async () => setManualMsg(await pay.verifyRef(manualRef))} disabled={!manualRef.trim()} className="px-4 min-h-11 rounded-lg bg-brand text-white font-semibold disabled:opacity-50">
          Verificar pago
        </button>
        {manualMsg && <p className="text-body">{manualMsg}</p>}
      </div>
    </details>
  );

  let body: React.ReactNode;
  if (note) {
    body = (
      <div className="space-y-3">
        <div className="text-5xl text-warn-ink">!</div>
        <p className="text-[14px] text-body">{note}</p>
        <button onClick={onClose} className="min-h-11 px-5 rounded-lg border border-field text-[14px] font-medium text-body">
          Volver a la caja
        </button>
      </div>
    );
  } else
    switch (phase) {
      case "choose":
        body = (
          <PayChoice
            size="pos"
            who="cajero"
            total={sale?.total ?? (start.mode === "new" ? start.total : 0)}
            qrAvailable={qrAvailable}
            busy={pay.busy}
            error={pay.error}
            test={undefined}
            note={sale?.attempt && sale.attempt > 0 ? `Intento ${sale.attempt + 1}` : undefined}
            onQr={() => void pay.choose("qr")}
            onScreen={() => void pay.choose("pantalla")}
            onBack={sale ? undefined : onClose}
            onCancel={() => void cancelPurchase()}
          />
        );
        break;
      case "creating":
        body = (
          <div className="py-6 flex flex-col items-center gap-3">
            <Spinner size="pos" />
            <p className="text-[15px]">Preparando el cobro…</p>
          </div>
        );
        break;
      case "confirm_total":
        body = (
          <>
            <p className="text-[15px]">El total cambió porque los precios se actualizaron.</p>
            {start.mode === "new" && <div className="text-[13px] text-dim">Antes: {formatCOP(start.total)}</div>}
            <div className="text-4xl font-extrabold">{formatCOP(sale?.total ?? 0)}</div>
            <div className="flex gap-3 justify-center pt-2">
              <button onClick={() => void cancelPurchase()} className="min-h-11 px-5 rounded-lg border border-field text-[14px] font-medium text-body">
                Cancelar
              </button>
              <button onClick={pay.confirmTotal} className="min-h-11 px-6 rounded-lg bg-brand text-white text-[15px] font-bold">
                Cobrar {formatCOP(sale?.total ?? 0)}
              </button>
            </div>
          </>
        );
        break;
      case "qr":
        body = (
          <>
            <QrScan size="pos" qr={pay.qr} local={sale?.local ?? ""} total={sale?.total ?? 0} mmss={pay.mmss} opened={!!pay.attemptInfo?.qr_opened || !!pay.error} />
            {!pay.attemptInfo?.qr_opened && !pay.attemptInfo?.evidence && (
              <div className="flex flex-wrap gap-3 justify-center">
                <button onClick={pay.changeMethod} className="min-h-11 px-5 rounded-lg border border-brand text-brand-text text-[14px] font-semibold hover:bg-brand-soft">
                  Cambiar forma de pago
                </button>
              </div>
            )}
            {cancelBar}
          </>
        );
        break;
      case "window":
        body = (
          <>
            <div>
              <div className="text-[13px] font-semibold text-body">Total a pagar</div>
              <div className="text-4xl font-extrabold">{formatCOP(sale?.total ?? 0)}</div>
            </div>
            <p className="text-[15px]">El cliente está pagando en la ventana de ePayco…</p>
            <p className="text-[13px] text-dim">
              Esperando la confirmación · vence en <b>{pay.mmss}</b>
            </p>
            {onLocalhost && (
              <p className="text-[12px] text-warn-ink bg-warn-soft border border-warn-line rounded-lg px-3 py-2">
                Está usando <b>localhost</b>: ePayco no puede devolver a esta pantalla al terminar. Abra la caja en <b>http://127.0.0.1:3000</b>.
              </p>
            )}
            {cancelBar}
          </>
        );
        break;
      case "verifying":
        body = (
          <>
            <VerifyingView size="pos" />
            {manual}
          </>
        );
        break;
      case "in_process":
        body = (
          <>
            <InProcessView size="pos" local={sale?.local ?? ""} mmss={pay.mmss} onWait={() => {}} onCancel={() => void cancelPurchase()} cancelling={pay.cancelling} />
            {manual}
          </>
        );
        break;
      case "confirm_paid":
        body = (
          <>
            <NoConfirmationView size="pos" local={sale?.local ?? ""} mmss={pay.mmss} busy={pay.busy} error={pay.error} onPaid={pay.saidPaid} onRetry={pay.notPaid} onCancel={() => void cancelPurchase()} />
            {manual}
          </>
        );
        break;
      case "cancelled":
        body = <CancelledView size="pos" busy={pay.busy} onRetry={pay.retry} onCancel={() => void cancelPurchase()} />;
        break;
      case "rejected":
      case "expired":
        body = (
          <RejectedView
            size="pos"
            who="cajero"
            busy={pay.busy}
            message={phase === "expired" ? "Se agotó el tiempo para pagar. Puede intentarlo de nuevo." : undefined}
            onRetry={pay.retry}
            onCancel={() => void cancelPurchase()}
          />
        );
        break;
      case "processing":
        body = (
          <div className="py-6 space-y-2">
            <div className="text-3xl">✓</div>
            <p className="text-[16px] font-semibold">Pago recibido</p>
            <p className="text-[14px] text-dim">Generando la factura…</p>
          </div>
        );
        break;
      case "paid":
        body = (
          <div className="space-y-3">
            <div className="text-5xl text-ok-ink">✓</div>
            <h3 className="text-xl font-bold">Pago recibido</h3>
            <p className="text-[14px] text-body">El pago fue aprobado y la factura quedó generada.</p>
            {pay.invoice && <p className="text-lg font-bold">Factura {pay.invoice}</p>}
            {sale && (
              <button onClick={() => printTicket(sale.id)} className="min-h-11 px-4 rounded-lg border border-field text-[14px] font-medium text-body">
                Reimprimir tirilla
              </button>
            )}
            <div>
              <button onClick={done} className="min-h-12 px-8 rounded-lg bg-go hover:bg-go-hover text-white text-lg font-bold">
                Listo
              </button>
            </div>
          </div>
        );
        break;
      case "paid_review":
      case "review":
        body = (
          <div className="space-y-3">
            <div className="text-5xl text-warn-ink">!</div>
            <h3 className="text-xl font-bold">{phase === "paid_review" ? "Pago recibido" : "Pago por revisar"}</h3>
            <p className="text-[14px] text-body">
              {phase === "paid_review"
                ? `El pago fue aprobado, pero la factura quedó pendiente de revisión. Compra ${sale?.local}: un administrador debe revisarla.`
                : `No se pudo confirmar el pago automáticamente. Compra ${sale?.local}: un administrador debe revisarla en "Pagos por revisar". No cobre de nuevo.`}
            </p>
            <button onClick={done} className="min-h-12 px-8 rounded-lg bg-go hover:bg-go-hover text-white text-lg font-bold">
              Listo
            </button>
          </div>
        );
        break;
    }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-[640px] max-h-[94vh] overflow-y-auto text-fg">
        <div className="px-6 py-3 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-bold">Pago electrónico (ePayco)</h2>
          {sale && <span className="text-[13px] text-dim">Compra {sale.local}</span>}
        </div>
        <div className="p-6 space-y-4 text-center">
          {sale?.test && !["paid", "paid_review", "review"].includes(phase) && (
            <div className="rounded-lg bg-warn-soft border border-warn-line text-warn-ink text-[13px] px-3 py-2">MODO DE PRUEBA: no se cobra dinero real.</div>
          )}
          {body}
        </div>
      </div>
    </div>
  );
}
