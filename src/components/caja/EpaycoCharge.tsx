"use client";

// Cobro con ePayco (checkout onpage) desde la CAJA. Usa los mismos endpoints y la misma verificación del kiosco:
// el navegador solo manda productos y cantidades; el servidor calcula el total, verifica el pago con ePayco y factura.
// Lo que reporte ePayco al navegador (hooks / ref_payco) es solo una PISTA: nunca marca la venta como pagada.
// Canales (uno a la vez, lo hace cumplir el servidor):
//   - "qr" (predeterminado en la caja si hay dominio público): QR hacia /pagar/<código>; NO se abre la ventana en pantalla.
//   - "pantalla": checkout onpage de ePayco en este equipo; el enlace del celular queda cerrado.
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { findRef, openOnpageCheckout, shapeOf } from "@/components/kiosco/epayco-client";
import { printTicket } from "@/lib/client/print";
import { formatCOP, type CartLine } from "@/lib/money";
import type { CheckoutResult } from "./CheckoutModal";

export type PayChannel = "qr" | "pantalla";
export type EpaycoSale = {
  id: string;
  local: string;
  total: number;
  /** sesión del checkout en pantalla (null mientras el canal sea QR) */
  sessionId: string | null;
  expiresAt: string;
  test: boolean;
  /** enlace del celular (solo con canal QR) */
  payUrl?: string | null;
  channel?: PayChannel;
  qrAvailable?: boolean;
};
export type EpaycoStart =
  | { mode: "new"; cart: CartLine[]; result: CheckoutResult; total: number }
  | { mode: "resume"; sale: EpaycoSale; ref: string | null };

type Phase = "creando" | "confirmar_total" | "pagando" | "procesando" | "resultado";
type Outcome = { tone: "ok" | "warn" | "error"; title: string; message: string; paid: boolean; retry: boolean; invoiced?: boolean };
type StatusResp = { status: string; payment_status: string | null; local_number: string; invoice_name: string | null };

const json = { "Content-Type": "application/json" };

// La venta en curso se guarda en este navegador: si ePayco recarga la página al terminar (/caja?ref_payco=...) se retoma.
const STORE_KEY = "fecp_caja_epayco_v1";
const saveSale = (s: EpaycoSale | null) => {
  try {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
  } catch {}
};
/** Venta de ePayco que quedó en curso en este navegador (null si no hay o ya es muy vieja). */
export function loadStoredSale(): EpaycoSale | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as EpaycoSale;
    if (!s?.id || new Date(s.expiresAt).getTime() < Date.now() - 30 * 60_000) {
      saveSale(null);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export default function EpaycoCharge({
  start,
  onFinished,
  onClose,
}: {
  start: EpaycoStart;
  /** El pago quedó recibido (facturado o por revisar): hay que vaciar el carrito */
  onFinished: () => void;
  /** Volver a la caja SIN vaciar el carrito (no se pagó o se canceló) */
  onClose: () => void;
}) {
  const resume = start.mode === "resume";
  const [phase, setPhase] = useState<Phase>(resume ? "pagando" : "creando");
  const [sale, setSale] = useState<EpaycoSale | null>(resume ? start.sale : null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [closed, setClosed] = useState(resume); // ¿el checkout de ePayco está cerrado? (al retomar, sí)
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [askCancel, setAskCancel] = useState(false);
  const [manualRef, setManualRef] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  const [onLocalhost] = useState(() => typeof location !== "undefined" && location.hostname === "localhost");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");

  const saleRef = useRef<EpaycoSale | null>(resume ? start.sale : null);
  const refPayco = useRef<string | null>(resume ? start.ref : null); // solo una PISTA: el servidor la verifica con ePayco
  const reopen = useRef<(() => void) | null>(null);
  const tickBusy = useRef(false);
  const started = useRef(false); // evita crear dos cobros si React ejecuta el efecto dos veces
  const printed = useRef(false);
  const hooksLogged = useRef(new Set<string>());

  const finish = useCallback((o: Outcome) => {
    saveSale(null); // la venta ya terminó: no se retoma
    setOutcome(o);
    setPhase("resultado");
  }, []);

  const handleStatus = useCallback(
    (st: StatusResp) => {
      const local = st.local_number;
      switch (st.status) {
        case "esperando_pago":
          return;
        case "pagado":
        case "pending":
        case "invoicing":
          setPhase("procesando");
          return;
        case "invoiced":
          setInvoice(st.invoice_name);
          finish({ tone: "ok", title: "Pago recibido", message: "El pago fue aprobado y la factura quedó generada.", paid: true, invoiced: true, retry: false });
          if (saleRef.current && !printed.current) {
            printed.current = true;
            printTicket(saleRef.current.id);
          }
          return;
        case "failed":
        case "revisar":
          finish({ tone: "warn", title: "Pago recibido", message: `El pago fue aprobado, pero la factura quedó pendiente de revisión. Compra ${local}: un administrador debe revisarla.`, paid: true, retry: false });
          return;
        case "pago_fallido":
          finish({ tone: "error", title: "No se completó el pago", message: st.payment_status === "vencido" ? "Se agotó el tiempo para pagar." : "El pago no fue aprobado.", paid: false, retry: true });
          return;
        case "pago_por_revisar":
        case "pago_tardio":
          finish({ tone: "warn", title: "Pago por revisar", message: `No se pudo confirmar el pago automáticamente. Compra ${local}: un administrador debe revisarla en "Pagos por revisar". No cobre de nuevo.`, paid: true, retry: false });
          return;
      }
    },
    [finish]
  );

  // ---------------------------------------------------------------- abrir el checkout
  const startCheckout = useCallback(async (s: EpaycoSale) => {
    setPhase("pagando");
    if (!s.sessionId) {
      setClosed(true);
      return;
    }
    setClosed(false);
    try {
      reopen.current = await openOnpageCheckout(s.sessionId, s.test, {
        onPayload: (hook, payload) => {
          const ref = findRef(payload);
          if (ref) refPayco.current = ref;
          if (hook === "onClosed") setClosed(true);
          if (!hooksLogged.current.has(hook)) {
            hooksLogged.current.add(hook);
            void fetch(`/api/kiosco/pagos/${s.id}/hooks`, { method: "POST", headers: json, body: JSON.stringify({ hook, keys: shapeOf(payload), refFound: !!ref }) }).catch(() => {});
          }
        },
      });
    } catch (e) {
      setClosed(true);
      // Diagnóstico: por qué no se pudo abrir la ventana de ePayco
      void fetch(`/api/kiosco/pagos/${s.id}/hooks`, { method: "POST", headers: json, body: JSON.stringify({ hook: "open_error", keys: [e instanceof Error ? e.message.slice(0, 60) : "error"], refFound: false }) }).catch(() => {});
    }
  }, []);

  /** Empieza a cobrar por el canal del cobro: en pantalla abre el checkout; con QR solo muestra el código. */
  const begin = useCallback(
    (s: EpaycoSale) => {
      if (s.channel === "qr") {
        reopen.current = null;
        setClosed(true);
        setPhase("pagando");
      } else void startCheckout(s);
    },
    [startCheckout]
  );

  /** Cambia de canal EN EL SERVIDOR (el anterior queda cerrado) y luego en la pantalla. */
  const switchChannel = useCallback(
    async (to: PayChannel) => {
      const s = saleRef.current;
      if (!s || switching) return;
      setSwitching(true);
      setSwitchError("");
      try {
        const r = await fetch(`/api/kiosco/pagos/${s.id}/canal`, { method: "POST", headers: json, body: JSON.stringify({ channel: to }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setSwitchError(d.error ?? "No se pudo cambiar el medio de pago.");
          return;
        }
        const next: EpaycoSale = { ...s, channel: d.channel, sessionId: d.session_id ?? null, payUrl: d.pay_url ?? null };
        saleRef.current = next;
        hooksLogged.current = new Set();
        saveSale(next);
        setSale(next);
        begin(next);
      } catch {
        setSwitchError("Sin conexión. Intente de nuevo.");
      } finally {
        setSwitching(false);
      }
    },
    [begin, switching]
  );

  // ---------------------------------------------------------------- crear el cobro
  const createPayment = useCallback(async () => {
    if (start.mode !== "new") return;
    setPhase("creando");
    setOutcome(null);
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
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        finish({ tone: "error", title: "No se pudo iniciar el cobro", message: d.error ?? "Intente de nuevo.", paid: false, retry: true });
        return;
      }
      const s: EpaycoSale = {
        id: d.sale_id, local: d.local_number, total: d.total, sessionId: d.session_id ?? null, expiresAt: d.expires_at, test: !!d.test,
        payUrl: d.pay_url ?? null, channel: d.channel === "qr" ? "qr" : "pantalla", qrAvailable: !!d.qr_available,
      };
      saleRef.current = s;
      refPayco.current = null;
      hooksLogged.current = new Set();
      printed.current = false;
      saveSale(s);
      setSale(s);
      // Si los precios cambiaron desde que se armó el carrito, se avisa antes de cobrar
      if (Math.abs(s.total - start.total) > 0.01) setPhase("confirmar_total");
      else begin(s);
    } catch {
      finish({ tone: "error", title: "Sin conexión", message: "No se pudo conectar con el servidor. Intente de nuevo.", paid: false, retry: true });
    }
  }, [start, finish, begin]);

  useEffect(() => {
    if (start.mode !== "new" || started.current) return;
    started.current = true;
    void createPayment();
  }, [start, createPayment]);

  // ---------------------------------------------------------------- mensajes del checkout (sin depender de los hooks del SDK)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      let host = "";
      try {
        host = new URL(e.origin).hostname;
      } catch {
        return;
      }
      if (!/(^|\.)(epayco\.(co|io)|davipay\.com)$/.test(host)) return;
      const data = e.data as Record<string, unknown> | null;
      if (!saleRef.current || !data || typeof data !== "object") return;
      const ref = findRef(data);
      if (ref) refPayco.current = ref;
      const ev = typeof data.event === "string" ? data.event : "mensaje";
      if (ev === "onClosed") setClosed(true);
      // Diagnóstico (solo nombres de campos, nunca valores): qué manda ePayco al cerrar o terminar
      const key = `raw:${ev}`.slice(0, 20);
      if (!hooksLogged.current.has(key)) {
        hooksLogged.current.add(key);
        void fetch(`/api/kiosco/pagos/${saleRef.current.id}/hooks`, { method: "POST", headers: json, body: JSON.stringify({ hook: key, keys: [`origen:${host}`, ...shapeOf(data)], refFound: !!ref }) }).catch(() => {});
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // ---------------------------------------------------------------- QR del enlace de pago (solo con canal QR)
  const [qr, setQr] = useState<string | null>(null);
  const isQr = sale?.channel === "qr";
  const payUrl = isQr ? sale?.payUrl ?? null : null;
  useEffect(() => {
    if (!payUrl) return;
    let alive = true;
    QRCode.toDataURL(payUrl, { margin: 1, width: 260 })
      .then((u) => alive && setQr(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [payUrl]);

  // ---------------------------------------------------------------- cuenta regresiva
  useEffect(() => {
    if (phase !== "pagando" || !sale) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((new Date(sale.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [phase, sale]);

  // ---------------------------------------------------------------- cada 3 s: verificar (con ref_payco) o leer el estado
  useEffect(() => {
    if (phase !== "pagando") return;
    const tick = async () => {
      const s = saleRef.current;
      if (!s || tickBusy.current) return;
      tickBusy.current = true;
      try {
        if (refPayco.current) {
          const r = await fetch(`/api/kiosco/pagos/${s.id}/confirmar`, { method: "POST", headers: json, body: JSON.stringify({ ref_payco: refPayco.current }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok) {
            if (d.outcome === "pagado") return void setPhase("procesando");
            if (d.outcome === "rechazado") return finish({ tone: "error", title: "El pago fue rechazado", message: "El cliente puede intentarlo de nuevo o pagar con otro medio.", paid: false, retry: true });
            if (["por_revisar", "tardio", "duplicado"].includes(d.outcome)) {
              return finish({ tone: "warn", title: "Pago por revisar", message: `No se pudo confirmar el pago automáticamente. Compra ${s.local}: un administrador debe revisarla en "Pagos por revisar". No cobre de nuevo.`, paid: true, retry: false });
            }
          }
        }
        const st = await fetch(`/api/kiosco/pagos/${s.id}`, { cache: "no-store" });
        if (st.ok) handleStatus((await st.json()) as StatusResp);
      } catch {
        /* se reintenta en 3 s */
      } finally {
        tickBusy.current = false;
      }
    };
    const iv = setInterval(tick, 3000);
    void tick();
    return () => clearInterval(iv);
  }, [phase, finish, handleStatus]);

  // ---------------------------------------------------------------- pago confirmado: esperar a que la factura quede lista
  useEffect(() => {
    if (phase !== "procesando") return;
    const t0 = Date.now();
    const iv = setInterval(async () => {
      const s = saleRef.current;
      if (!s) return;
      if (Date.now() - t0 > 90_000) {
        finish({ tone: "warn", title: "Pago recibido", message: `El pago fue aprobado, pero la factura aún se está generando. Compra ${s.local}: revísela en Ventas.`, paid: true, retry: false });
        return;
      }
      try {
        const st = await fetch(`/api/kiosco/pagos/${s.id}`, { cache: "no-store" });
        if (st.ok) handleStatus((await st.json()) as StatusResp);
      } catch {}
    }, 2000);
    return () => clearInterval(iv);
  }, [phase, finish, handleStatus]);

  /** Respaldo: el cajero pega la referencia larga (o el enlace de ePayco que la contiene) y el servidor la verifica. */
  async function verifyManual() {
    const s = saleRef.current;
    if (!s) return;
    const text = manualRef.trim();
    const ref = /ref_payco=([A-Za-z0-9_-]{4,64})/.exec(text)?.[1] ?? (/^[A-Za-z0-9_-]{4,64}$/.test(text) ? text : null);
    if (!ref) return setManualMsg("Pegue la referencia o el enlace completo que muestra ePayco (contiene ref_payco=…).");
    setManualMsg("Verificando con ePayco…");
    try {
      const r = await fetch(`/api/kiosco/pagos/${s.id}/confirmar`, { method: "POST", headers: json, body: JSON.stringify({ ref_payco: ref }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setManualMsg(d.error ?? "No se pudo verificar esa referencia.");
      if (d.outcome === "pagado") return void setPhase("procesando");
      if (d.outcome === "rechazado") return finish({ tone: "error", title: "El pago fue rechazado", message: "El cliente puede intentarlo de nuevo o pagar con otro medio.", paid: false, retry: true });
      if (["por_revisar", "tardio", "duplicado"].includes(d.outcome)) {
        return finish({ tone: "warn", title: "Pago por revisar", message: `No se pudo confirmar el pago automáticamente. Compra ${s.local}: un administrador debe revisarla en "Pagos por revisar". No cobre de nuevo.`, paid: true, retry: false });
      }
      setManualMsg(d.message ?? "El pago aún no está confirmado.");
    } catch {
      setManualMsg("Sin conexión. Intente de nuevo.");
    }
  }

  function cancel() {
    saveSale(null); // la venta queda 'esperando_pago' y vence sola; el carrito NO se vacía
    onClose();
  }

  const mmss = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const tone = outcome?.tone;

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-[480px] overflow-hidden text-fg">
        <div className="px-6 py-3 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-bold">Pago electrónico (ePayco)</h2>
          {sale && <span className="text-[13px] text-dim">Compra {sale.local}</span>}
        </div>

        <div className="p-6 space-y-4 text-center">
          {sale?.test && phase !== "resultado" && (
            <div className="rounded-lg bg-warn-soft border border-warn-line text-warn-ink text-[13px] px-3 py-2">
              MODO DE PRUEBA: no se cobra dinero real.
            </div>
          )}

          {phase === "creando" && <p className="py-8 text-[15px]">Preparando el cobro…</p>}

          {phase === "confirmar_total" && sale && start.mode === "new" && (
            <>
              <p className="text-[15px]">El total cambió porque los precios se actualizaron.</p>
              <div className="text-[13px] text-dim">Antes: {formatCOP(start.total)}</div>
              <div className="text-4xl font-extrabold">{formatCOP(sale.total)}</div>
              <div className="flex gap-3 justify-center pt-2">
                <button onClick={cancel} className="px-5 py-3 rounded-lg border border-field text-[14px] font-medium text-body">
                  Cancelar
                </button>
                <button onClick={() => begin(sale)} className="px-6 py-3 rounded-lg bg-brand text-white text-[15px] font-bold">
                  Cobrar {formatCOP(sale.total)}
                </button>
              </div>
            </>
          )}

          {phase === "pagando" && sale && (
            <>
              <div>
                <div className="text-[13px] font-semibold text-body">Total a pagar</div>
                <div className="text-4xl font-extrabold">{formatCOP(sale.total)}</div>
              </div>
              {isQr ? (
                <div className="rounded-lg border border-line bg-white px-3 py-3 space-y-1">
                  {qr ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={qr} alt="QR para pagar desde el celular" className="mx-auto w-56 h-56 max-w-full" />
                  ) : (
                    <div className="mx-auto w-56 h-56 max-w-full grid place-items-center text-[13px] text-gray-600">Generando el QR…</div>
                  )}
                  <p className="text-[14px] font-semibold text-gray-900">El cliente escanea el QR y paga en su celular</p>
                </div>
              ) : (
                <p className="text-[15px]">
                  {closed ? "La ventana de pago está cerrada. Si el cliente aún no pagó, ábrala de nuevo." : "El cliente está pagando en la ventana de ePayco…"}
                </p>
              )}
              <p className="text-[13px] text-dim">
                Esperando la confirmación · vence en <b>{mmss}</b>
              </p>
              {switchError && <p className="text-[13px] text-err-ink">{switchError}</p>}
              {onLocalhost && (
                <p className="text-[12px] text-warn-ink bg-warn-soft border border-warn-line rounded-lg px-3 py-2">
                  Está usando <b>localhost</b>: ePayco no puede devolver a esta pantalla al terminar. Abra la caja en <b>http://127.0.0.1:3000</b>.
                </p>
              )}
              {closed && (
                <details className="text-left rounded-lg border border-line bg-subtle px-3 py-2 text-[13px]">
                  <summary className="cursor-pointer font-semibold text-body">¿El cliente ya pagó y no avanza?</summary>
                  <div className="pt-2 space-y-2">
                    <p className="text-dim">
                      Pegue aquí el enlace que muestra ePayco al terminar (el que contiene <b>ref_payco=</b>) o la referencia larga. El servidor la verifica con ePayco: no se confía en lo que digite.
                    </p>
                    <input
                      value={manualRef}
                      onChange={(e) => setManualRef(e.target.value)}
                      placeholder="https://…landingresume?ref_payco=…"
                      className="w-full border border-field rounded-lg px-3 py-2 text-[14px] text-fg outline-none focus:border-brand bg-surface"
                    />
                    <button onClick={() => void verifyManual()} disabled={!manualRef.trim()} className="px-4 py-2 rounded-lg bg-brand text-white font-semibold disabled:opacity-50">
                      Verificar pago
                    </button>
                    {manualMsg && <p className="text-body">{manualMsg}</p>}
                  </div>
                </details>
              )}
              <div className="flex flex-wrap gap-3 justify-center pt-1">
                {isQr && (
                  <button
                    onClick={() => void switchChannel("pantalla")}
                    disabled={switching}
                    className="px-5 py-3 min-h-11 rounded-lg border border-brand text-brand-text text-[14px] font-semibold hover:bg-brand-soft disabled:opacity-50"
                  >
                    {switching ? "Cambiando…" : "Pagar en esta pantalla"}
                  </button>
                )}
                {!isQr && closed && (
                  <button
                    onClick={() => (reopen.current ? reopen.current() : void startCheckout(sale))}
                    className="px-5 py-3 rounded-lg bg-brand text-white text-[14px] font-bold"
                  >
                    Abrir el pago de nuevo
                  </button>
                )}
                {!isQr && closed && sale.qrAvailable && (
                  <button
                    onClick={() => void switchChannel("qr")}
                    disabled={switching}
                    className="px-5 py-3 min-h-11 rounded-lg border border-brand text-brand-text text-[14px] font-semibold hover:bg-brand-soft disabled:opacity-50"
                  >
                    {switching ? "Cambiando…" : "Pagar con el celular (QR)"}
                  </button>
                )}
                {!askCancel ? (
                  <button onClick={() => setAskCancel(true)} className="px-5 py-3 rounded-lg border border-field text-[14px] font-medium text-body">
                    Cancelar cobro
                  </button>
                ) : (
                  <div className="w-full rounded-lg border border-err-line bg-err-soft px-3 py-3 text-[13px] text-err-ink">
                    Si el cliente ya pagó, NO cancele: espere la confirmación. ¿Cancelar el cobro?
                    <div className="flex gap-3 justify-center pt-2">
                      <button onClick={() => setAskCancel(false)} className="px-4 py-2 rounded-lg border border-field bg-surface text-body font-medium">
                        No, seguir esperando
                      </button>
                      <button onClick={cancel} className="px-4 py-2 rounded-lg bg-err text-white font-bold">
                        Sí, cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {phase === "procesando" && (
            <div className="py-6 space-y-2">
              <div className="text-3xl">✓</div>
              <p className="text-[16px] font-semibold">Pago recibido</p>
              <p className="text-[14px] text-dim">Generando la factura…</p>
            </div>
          )}

          {phase === "resultado" && outcome && (
            <div className="space-y-3">
              <div className={`text-5xl ${tone === "ok" ? "text-ok-ink" : tone === "warn" ? "text-warn-ink" : "text-err-ink"}`}>
                {tone === "ok" ? "✓" : tone === "warn" ? "!" : "✕"}
              </div>
              <h3 className="text-xl font-bold">{outcome.title}</h3>
              <p className="text-[14px] text-body">{outcome.message}</p>
              {invoice && <p className="text-lg font-bold">Factura {invoice}</p>}
              {outcome.invoiced && sale && (
                <button onClick={() => printTicket(sale.id)} className="px-4 py-2 rounded-lg border border-field text-[14px] font-medium text-body">
                  Reimprimir tirilla
                </button>
              )}
              <div className="flex gap-3 justify-center pt-2">
                {outcome.paid ? (
                  <button onClick={onFinished} className="px-8 py-3 rounded-lg bg-go hover:bg-go-hover text-white text-lg font-bold">
                    Listo
                  </button>
                ) : (
                  <>
                    <button onClick={onClose} className="px-5 py-3 rounded-lg border border-field text-[14px] font-medium text-body">
                      Volver a la caja
                    </button>
                    {outcome.retry && start.mode === "new" && (
                      <button
                        onClick={() => {
                          started.current = true;
                          void createPayment();
                        }}
                        className="px-6 py-3 rounded-lg bg-brand text-white text-[15px] font-bold"
                      >
                        Intentar de nuevo
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
