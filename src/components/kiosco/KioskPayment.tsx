"use client";

// Pantallas del pago electrónico en el KIOSCO. Toda la lógica (intentos, verificación, estados) está en useEpaycoPayment y en el
// servidor; aquí solo se arman las pantallas grandes y táctiles con los componentes compartidos con la caja.
// Todo el estado vive aquí: al salir de la pantalla de pago (o por inactividad) este componente se desmonta y no queda nada.
import { useEffect, useRef, useState } from "react";
import { CancelledView, InProcessView, NoConfirmationView, PayChoice, QrScan, RejectedView, Spinner, VerifyingView } from "@/components/epayco/PayViews";
import { useEpaycoPayment, type CreateResult, type PayChannel, type PaySale, type Phase } from "@/components/epayco/useEpaycoPayment";
import { formatCOP } from "@/lib/money";

export const KIOSK_STORE_KEY = "fecp_kiosk_sale_v1";

type Props = {
  cartTotal: number;
  qrAvailable: boolean;
  resume: { sale: PaySale; ref: string | null } | null;
  createSale: (channel: PayChannel) => Promise<CreateResult>;
  /** "Volver" desde la elección (todavía no hay venta): regresa a los datos del cliente */
  onBack: () => void;
  /** terminar o cancelar: el kiosco vuelve al inicio con todo vacío */
  onFinish: () => void;
  onPhase: (p: Phase) => void;
  /** el kiosco la llama por inactividad: avisa al servidor que se cancela (si hacía falta) */
  registerAbort: (fn: (() => void) | null) => void;
  onInvoiced: (saleId: string) => void;
};

function Center({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto flex flex-col items-center justify-center gap-5 text-center p-6 sm:p-10">{children}</div>;
}

export default function KioskPayment(p: Props) {
  const pay = useEpaycoPayment({ storeKey: KIOSK_STORE_KEY, createSale: p.createSale, expectedTotal: p.cartTotal, resume: p.resume, onInvoiced: p.onInvoiced });
  const { phase, sale } = pay;
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);
  const finishRef = useRef(p.onFinish);
  useEffect(() => {
    finishRef.current = p.onFinish;
  });

  useEffect(() => {
    p.onPhase(phase);
  }, [phase, p]);

  // Reinicio por inactividad: se avisa al servidor (la venta no queda abierta) y se borra todo
  useEffect(() => {
    p.registerAbort(() => {
      // En proceso o "¿completó el pago?": el pago puede estar en camino → la venta queda POR REVISAR (no cancelada) y el intento se conserva
      // para que la consulta activa lo siga verificando. En lo demás (elección, cancelado, rechazado) se cancela.
      if (sale && !["paid", "paid_review", "review", "processing"].includes(phase)) void pay.cancel({ keep: phase === "in_process" || phase === "confirm_paid" });
      pay.reset();
    });
    return () => p.registerAbort(null);
  });

  // Pantallas finales: vuelven solas al inicio
  useEffect(() => {
    if (!["paid", "paid_review", "review"].includes(phase) && !note) return;
    const t = setTimeout(() => finishRef.current(), phase === "paid" ? 25_000 : 60_000);
    return () => clearTimeout(t);
  }, [phase, note]);

  async function cancelPurchase() {
    const r = await pay.cancel();
    if (r.keptForReview && sale) {
      setNote({ title: "Su compra quedó registrada", text: `Si ya realizó el pago, no se perderá: quedó registrado para revisión. Acérquese a la caja con este número: ${sale.local}.` });
      return;
    }
    finishRef.current();
  }

  if (note) {
    return (
      <Center>
        <div className="text-7xl text-warn-ink" aria-hidden="true">!</div>
        <h1 className="text-4xl font-bold">{note.title}</h1>
        <p className="text-2xl text-soft max-w-2xl">{note.text}</p>
        <button onClick={() => finishRef.current()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
          Nueva compra
        </button>
      </Center>
    );
  }

  switch (phase) {
    case "choose":
      return (
        <Center>
          <PayChoice
            size="kiosk"
            who="cliente"
            total={sale?.total ?? p.cartTotal}
            qrAvailable={p.qrAvailable}
            busy={pay.busy}
            error={pay.error}
            note={sale?.attempt && sale.attempt > 0 ? `Intento ${sale.attempt + 1}` : undefined}
            onQr={() => void pay.choose("qr")}
            onScreen={() => void pay.choose("pantalla")}
            onBack={sale ? undefined : p.onBack}
            onCancel={() => void cancelPurchase()}
          />
        </Center>
      );
    case "creating":
      return (
        <Center>
          <Spinner size="kiosk" />
          <h1 className="text-3xl font-bold">Preparando su pago…</h1>
        </Center>
      );
    case "confirm_total":
      return (
        <Center>
          <h1 className="text-3xl font-bold">El total cambió</h1>
          <p className="text-xl text-soft max-w-xl">Los precios se actualizaron mientras compraba. Antes eran {formatCOP(p.cartTotal)}; el total a pagar ahora es:</p>
          <div className="text-5xl font-extrabold text-brand-text">{formatCOP(sale?.total ?? 0)}</div>
          <div className="flex gap-4">
            <button onClick={() => void cancelPurchase()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
              Cancelar
            </button>
            <button onClick={pay.confirmTotal} className="min-h-12 px-10 py-4 rounded-xl bg-go text-white text-2xl font-bold">
              Pagar {formatCOP(sale?.total ?? 0)}
            </button>
          </div>
        </Center>
      );
    case "qr":
      return (
        <Center>
          {sale?.test && <div className="rounded-xl bg-warn-soft border border-warn-line text-warn-ink px-5 py-2 text-lg font-semibold">MODO DE PRUEBA: no se cobra dinero real</div>}
          <QrScan size="kiosk" qr={pay.qr} local={sale?.local ?? ""} total={sale?.total ?? 0} mmss={pay.mmss} opened={!!pay.attemptInfo?.qr_opened || !!pay.error} />
          <div className="flex flex-wrap justify-center gap-4">
            <button onClick={() => void cancelPurchase()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
              Cancelar compra
            </button>
            {/* Si el QR ya se abrió en un celular o hay evidencia de pago NO se ofrece cambiar de canal (el servidor tampoco lo permite) */}
            {!pay.attemptInfo?.qr_opened && !pay.attemptInfo?.evidence && (
              <button onClick={pay.changeMethod} className="min-h-12 px-8 py-4 rounded-xl border-2 border-brand text-brand-text text-xl font-semibold bg-surface">
                Cambiar forma de pago
              </button>
            )}
          </div>
        </Center>
      );
    case "window":
      return (
        <Center>
          {sale?.test && <div className="rounded-xl bg-warn-soft border border-warn-line text-warn-ink px-5 py-2 text-lg font-semibold">MODO DE PRUEBA: no se cobra dinero real</div>}
          <h1 className="text-3xl font-bold">Complete el pago en la ventana de ePayco</h1>
          <div className="text-5xl font-extrabold text-brand-text">{formatCOP(sale?.total ?? 0)}</div>
          <p className="text-[18px] text-soft">
            Compra <b>{sale?.local}</b> · Tiempo restante <b>{pay.mmss}</b>
          </p>
          <p className="text-[16px] text-dim max-w-xl">Esta pantalla se actualiza sola cuando el pago sea aprobado. No toque nada más.</p>
          <button onClick={() => void cancelPurchase()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
            Cancelar compra
          </button>
        </Center>
      );
    case "verifying":
      return (
        <Center>
          <VerifyingView size="kiosk" />
        </Center>
      );
    case "in_process":
      return (
        <Center>
          <InProcessView size="kiosk" local={sale?.local ?? ""} mmss={pay.mmss} onWait={() => {}} onCancel={() => void cancelPurchase()} cancelling={pay.cancelling} />
        </Center>
      );
    case "confirm_paid":
      return (
        <Center>
          <NoConfirmationView size="kiosk" local={sale?.local ?? ""} mmss={pay.mmss} busy={pay.busy} error={pay.error} onPaid={pay.saidPaid} onRetry={pay.notPaid} onCancel={() => void cancelPurchase()} />
        </Center>
      );
    case "cancelled":
      return (
        <Center>
          <CancelledView size="kiosk" busy={pay.busy} onRetry={pay.retry} onCancel={() => void cancelPurchase()} />
        </Center>
      );
    case "rejected":
    case "expired":
      return (
        <Center>
          <RejectedView
            size="kiosk"
            who="cliente"
            busy={pay.busy}
            message={phase === "expired" ? "Se agotó el tiempo para pagar. Puede intentarlo de nuevo." : undefined}
            onRetry={pay.retry}
            onCancel={() => void cancelPurchase()}
          />
        </Center>
      );
    case "processing":
      return (
        <Center>
          <Spinner size="kiosk" />
          <h1 className="text-3xl font-bold">Pago recibido</h1>
          <p className="text-xl text-soft">Estamos generando su factura…</p>
        </Center>
      );
    case "paid":
      return (
        <Center>
          <div className="text-7xl text-ok-ink" aria-hidden="true">✓</div>
          <h1 className="text-4xl font-bold">¡Gracias por su compra!</h1>
          <p className="text-xl text-soft max-w-2xl">Su pago fue recibido y su factura quedó generada.</p>
          {pay.invoice && <div className="text-3xl font-bold text-fg">Factura {pay.invoice}</div>}
          {sale && <div className="text-[18px] text-soft">Número de compra: <b>{sale.local}</b></div>}
          <button onClick={() => finishRef.current()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
            Nueva compra
          </button>
        </Center>
      );
    case "paid_review":
      return (
        <Center>
          <div className="text-7xl text-warn-ink" aria-hidden="true">!</div>
          <h1 className="text-4xl font-bold">Pago recibido</h1>
          <p className="text-xl text-soft max-w-2xl">Su factura se está terminando de generar. Guarde este número de compra por si lo necesita.</p>
          {sale && <div className="text-[18px] text-soft">Número de compra: <b>{sale.local}</b></div>}
          <button onClick={() => finishRef.current()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
            Nueva compra
          </button>
        </Center>
      );
    case "review":
      return (
        <Center>
          <div className="text-7xl text-warn-ink" aria-hidden="true">!</div>
          <h1 className="text-4xl font-bold">Estamos verificando su pago</h1>
          <p className="text-xl text-soft max-w-2xl">No pudimos confirmar su pago automáticamente. Acérquese a la caja con este número: {sale?.local}.</p>
          <button onClick={() => finishRef.current()} className="min-h-12 px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
            Nueva compra
          </button>
        </Center>
      );
  }
}
