"use client";

// Lógica COMPARTIDA del cobro con ePayco (kiosco y caja). El navegador solo muestra y pregunta: el SERVIDOR decide.
//   choose ─► (crear venta o intento nuevo) ─► qr | window ─► [cierra la ventana] verifying ─► in_process
//   y desde cualquiera: processing → paid | paid_review | review · cancelled | rejected | expired
// Lo que reporte ePayco al navegador (hooks, ref_payco) es solo una PISTA: se la manda al servidor, que consulta a ePayco.
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { findRef, openOnpageCheckout, shapeOf } from "@/components/kiosco/epayco-client";

export type PayChannel = "qr" | "pantalla";
export type PaySale = {
  id: string;
  local: string;
  total: number;
  /** sesión del checkout en pantalla (null mientras el canal sea QR) */
  sessionId: string | null;
  expiresAt: string;
  test: boolean;
  payUrl?: string | null;
  channel: PayChannel;
  qrAvailable?: boolean;
  attempt?: number;
};
export type Phase =
  | "choose" | "creating" | "confirm_total" | "qr" | "window" | "verifying" | "in_process" | "confirm_paid"
  | "cancelled" | "rejected" | "expired" | "processing" | "paid" | "paid_review" | "review";

type Attempt = {
  no: number; status: string; channel: PayChannel; reason: string | null;
  /** hay evidencia de pago en curso (ref_payco, pendiente en ePayco o aviso del webhook) */
  evidence?: boolean;
  /** la página QR de este intento ya se abrió en un celular: no se puede cambiar de canal */
  qr_opened?: boolean;
} | null;
export type ServerState = {
  status: string;
  payment_status: string | null;
  local_number: string;
  total: number;
  invoice_name: string | null;
  expires_at: string | null;
  attempt: Attempt;
  outcome?: string | null;
};

/** Cuánto se verifica tras cerrar la ventana antes de pasar a "su pago está en proceso" */
export const VERIFY_WINDOW_MS = 15_000;
const EVERY_MS: Partial<Record<Phase, number>> = { qr: 3000, window: 3000, verifying: 2500, in_process: 5000, confirm_paid: 5000, processing: 2000 };
const PROCESSING_MAX_MS = 90_000;
const json = { "Content-Type": "application/json" };

export type CreateResult = { ok: true; sale: PaySale } | { ok: false; error: string };

export function useEpaycoPayment(o: {
  /** clave de localStorage para retomar la venta si se recarga la pantalla (ePayco puede volver a /kiosco o /caja con ?ref_payco=) */
  storeKey: string;
  /** crea la VENTA (con su primer intento) con el canal elegido. El total y los precios los calcula el servidor. */
  createSale: (channel: PayChannel) => Promise<CreateResult>;
  /** total que vio la persona al armar la compra: si el servidor calcula otro, se avisa antes de cobrar */
  expectedTotal?: number;
  /** retomar una venta en curso (al volver de ePayco o recargar) */
  resume?: { sale: PaySale; ref: string | null } | null;
  /** la factura quedó lista (para imprimir la tirilla) */
  onInvoiced?: (saleId: string) => void;
}) {
  const [phase, setPhaseState] = useState<Phase>(o.resume ? "verifying" : "choose");
  const [sale, setSale] = useState<PaySale | null>(o.resume?.sale ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [attemptInfo, setAttemptInfo] = useState<Attempt>(null); // último intento según el servidor
  const [saleClosed, setSaleClosed] = useState(false); // la VENTA ya no admite otro intento (venció o fue cancelada): "reintentar" crea una compra nueva

  const phaseRef = useRef<Phase>(phase);
  const saleRef = useRef<PaySale | null>(o.resume?.sale ?? null);
  const refPayco = useRef<string | null>(o.resume?.ref ?? null); // solo una PISTA: el servidor la verifica con ePayco
  const reopen = useRef<(() => void) | null>(null);
  const hooksLogged = useRef(new Set<string>());
  const tickBusy = useRef(false);
  const verifyStart = useRef(0);
  const processingStart = useRef(0);
  const replaceNext = useRef(false); // el próximo intento reemplaza al abierto (cambio de QR a pantalla, o la ventana nunca abrió)
  const saleClosedRef = useRef(false);
  const evidenceRef = useRef(false);
  const busyRef = useRef(false);
  const chooseRef = useRef<((c: PayChannel) => Promise<void>) | null>(null);
  const invoicedFired = useRef(false);
  const onInvoiced = useRef(o.onInvoiced);
  useEffect(() => {
    onInvoiced.current = o.onInvoiced;
  });

  useEffect(() => {
    verifyStart.current = Date.now(); // al retomar una venta se empieza a verificar desde ahora
  }, []);

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    if (p === "verifying") verifyStart.current = Date.now();
    if (p === "processing") processingStart.current = Date.now();
    setPhaseState(p);
  }, []);

  const persist = useCallback(
    (s: PaySale | null) => {
      try {
        if (s) localStorage.setItem(o.storeKey, JSON.stringify(s));
        else localStorage.removeItem(o.storeKey);
      } catch {}
    },
    [o.storeKey]
  );

  // ---------------------------------------------------------------- estado del servidor → pantalla
  const applyState = useCallback(
    (st: ServerState) => {
      const cur = phaseRef.current;
      const waiting = cur === "qr" || cur === "window" || cur === "verifying" || cur === "in_process" || cur === "confirm_paid" || cur === "processing";
      if (!waiting) return;
      const a = st.attempt;
      setAttemptInfo(a);
      switch (st.status) {
        case "invoiced":
          setInvoice(st.invoice_name);
          persist(null);
          setPhase("paid");
          if (saleRef.current && !invoicedFired.current) {
            invoicedFired.current = true;
            onInvoiced.current?.(saleRef.current.id);
          }
          return;
        case "pagado":
        case "pending":
        case "invoicing":
          if (cur !== "processing") setPhase("processing");
          return;
        case "failed":
        case "revisar":
          persist(null);
          setPhase("paid_review");
          return;
        case "pago_por_revisar":
        case "pago_tardio":
          persist(null);
          setPhase("review");
          return;
        case "pago_fallido":
        case "anulada":
          persist(null);
          saleClosedRef.current = true;
          setSaleClosed(true);
          setPhase(st.payment_status === "cancelado" ? "cancelled" : st.payment_status === "vencido" || st.status === "anulada" ? "expired" : "rejected");
          return;
        case "esperando_pago": {
          if (cur === "processing") return;
          switch (a?.status) {
            case "aprobado":
              setPhase("processing");
              return;
            case "cancelado":
              setPhase("cancelled");
              return;
            case "rechazado":
            case "vencido":
              setPhase("rejected");
              return;
            case "pendiente":
              // Con la ventana todavía abierta no se cambia de pantalla; al cerrarla (verifying), en "¿completó el pago?" o en el QR: "en proceso"
              if (cur !== "window") setPhase("in_process");
              return;
            default:
              // Apareció evidencia de pago (ref_payco o aviso del webhook): de "¿completó el pago?" pasa a "en proceso"
              if (cur === "confirm_paid" && a?.evidence) setPhase("in_process");
              return;
          }
          return;
        }
      }
    },
    [persist, setPhase]
  );

  const poll = useCallback(async () => {
    const s = saleRef.current;
    if (!s || tickBusy.current) return;
    tickBusy.current = true;
    try {
      const r = await fetch(`/api/kiosco/pagos/${s.id}/verificar`, { method: "POST", headers: json, body: JSON.stringify({ ref_payco: refPayco.current ?? undefined }) });
      if (r.ok) applyState((await r.json()) as ServerState);
      // Sin resultado final tras la ventana de verificación (15 s):
      //  - CON evidencia de pago en curso (ref_payco, pendiente o aviso del webhook): "su pago está en proceso" (típico de PSE), sin reintento.
      //  - SIN ninguna evidencia: "¿completó el pago?" — la persona decide (el servidor aplica la misma regla al abrir otro intento).
      if (phaseRef.current === "verifying" && Date.now() - verifyStart.current > VERIFY_WINDOW_MS) {
        setPhase(evidenceRef.current || refPayco.current ? "in_process" : "confirm_paid");
      }
      if (phaseRef.current === "processing" && Date.now() - processingStart.current > PROCESSING_MAX_MS) setPhase("paid_review");
    } catch {
      /* se reintenta en el próximo ciclo */
    } finally {
      tickBusy.current = false;
    }
  }, [applyState, setPhase]);

  useEffect(() => {
    const ms = EVERY_MS[phase];
    if (!ms) return;
    void poll();
    const iv = setInterval(() => void poll(), ms);
    return () => clearInterval(iv);
  }, [phase, poll]);

  // ---------------------------------------------------------------- ventana de ePayco
  const markClosed = useCallback(() => {
    if (phaseRef.current !== "window") return;
    setPhase("verifying");
    void poll();
  }, [poll, setPhase]);

  const openWindow = useCallback(
    async (s: PaySale) => {
      setPhase("window");
      if (!s.sessionId) {
        replaceNext.current = true;
        setError("No se pudo abrir la ventana de pago. Elija de nuevo cómo pagar.");
        setPhase("choose");
        return;
      }
      try {
        reopen.current = await openOnpageCheckout(s.sessionId, s.test, {
          onPayload: (hook, payload) => {
            const ref = findRef(payload);
            if (ref) refPayco.current = ref;
            if (!hooksLogged.current.has(hook)) {
              hooksLogged.current.add(hook);
              void fetch(`/api/kiosco/pagos/${s.id}/hooks`, { method: "POST", headers: json, body: JSON.stringify({ hook, keys: shapeOf(payload), refFound: !!ref }) }).catch(() => {});
            }
            // onClosed: la persona cerró o canceló la ventana (también tras terminar el pago). onResponse: ePayco ya tiene un resultado.
            if (hook === "onClosed") markClosed();
            else if (hook === "onResponse") void poll();
          },
        });
      } catch (e) {
        // La ventana nunca llegó a abrirse: no hay pago posible en ese intento; el siguiente lo reemplaza
        replaceNext.current = true;
        void fetch(`/api/kiosco/pagos/${s.id}/hooks`, { method: "POST", headers: json, body: JSON.stringify({ hook: "open_error", keys: [e instanceof Error ? e.message.slice(0, 60) : "error"], refFound: false }) }).catch(() => {});
        setError("No se pudo abrir la ventana de pago. Elija de nuevo cómo pagar.");
        setPhase("choose");
      }
    },
    [markClosed, poll, setPhase]
  );

  const begin = useCallback(
    (s: PaySale) => {
      reopen.current = null;
      if (s.channel === "qr") setPhase("qr");
      else void openWindow(s);
    },
    [openWindow, setPhase]
  );

  // Mensajes de los dominios de ePayco (el SDK solo reconoce algunos): pueden traer el ref_payco y el evento onClosed
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      let host = "";
      try {
        host = new URL(e.origin).hostname;
      } catch {
        return;
      }
      if (!/(^|\.)(epayco\.(co|io)|davipay\.com)$/.test(host)) return;
      const s = saleRef.current;
      const data = e.data as Record<string, unknown> | null;
      if (!s || !data || typeof data !== "object") return;
      const ref = findRef(data);
      if (ref) refPayco.current = ref;
      const ev = typeof data.event === "string" ? data.event : "mensaje";
      if (ev === "onClosed") markClosed();
      const key = `raw:${ev}`.slice(0, 20);
      if (!hooksLogged.current.has(key)) {
        hooksLogged.current.add(key);
        void fetch(`/api/kiosco/pagos/${s.id}/hooks`, { method: "POST", headers: json, body: JSON.stringify({ hook: key, keys: [`origen:${host}`, ...shapeOf(data)], refFound: !!ref }) }).catch(() => {});
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [markClosed]);

  // Respaldo: si los hooks no se disparan, el cierre se detecta cuando desaparece el iframe de ePayco
  useEffect(() => {
    if (phase !== "window") return;
    let seen = false;
    const isEpayco = (n: Node) => n instanceof HTMLIFrameElement && /epayco|davipay/i.test(n.src || "");
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        m.addedNodes.forEach((n) => {
          if (isEpayco(n)) seen = true;
          else if (n instanceof HTMLElement && n.querySelector("iframe[src*='epayco' i], iframe[src*='davipay' i]")) seen = true;
        });
        m.removedNodes.forEach((n) => {
          if (seen && (isEpayco(n) || (n instanceof HTMLElement && n.querySelector("iframe[src*='epayco' i], iframe[src*='davipay' i]")))) markClosed();
        });
      }
    });
    if (document.querySelector("iframe[src*='epayco' i], iframe[src*='davipay' i]")) seen = true;
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [phase, markClosed]);

  // ---------------------------------------------------------------- elegir cómo pagar (primer intento o "intentar de nuevo")
  const choose = useCallback(
    async (channel: PayChannel) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        const cur = saleRef.current;
        let next: PaySale;
        if (cur && !saleClosedRef.current) {
          // MISMA venta: intento nuevo con su propia referencia (el servidor lo rechaza si hay un pago pendiente o ya está pagada)
          const r = await fetch(`/api/kiosco/pagos/${cur.id}/intento`, { method: "POST", headers: json, body: JSON.stringify({ channel, replace: replaceNext.current }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            if (d.code === "pendiente" || d.code === "evidencia") {
              setError(d.error ?? "Su pago puede estar en curso.");
              setPhase("in_process");
              return;
            }
            if (d.code === "pagada") return void setPhase("processing");
            if (d.code === "qr_abierto") {
              setError(d.error ?? "Este pago se abrió en un celular. Termine el pago allí o cancele la compra.");
              setPhase("qr");
              return;
            }
            if (d.code === "vencida") {
              // La venta ya no admite intentos (venció o se canceló por abandono): se arranca una compra nueva con lo que la persona ya armó
              saleClosedRef.current = true;
              setSaleClosed(true);
              saleRef.current = null;
              setSale(null);
              persist(null);
              busyRef.current = false;
              setBusy(false);
              return void (await chooseRef.current?.(channel));
            }
            setError(d.error ?? "No se pudo iniciar el pago.");
            return;
          }
          next = { ...cur, channel: d.channel, sessionId: d.session_id ?? null, payUrl: d.pay_url ?? null, attempt: d.attempt };
          replaceNext.current = false;
        } else {
          setPhase("creating");
          const r = await o.createSale(channel);
          if (!r.ok) {
            setError(r.error);
            setPhase("choose");
            return;
          }
          next = r.sale;
          saleClosedRef.current = false;
          setSaleClosed(false);
          replaceNext.current = false;
          invoicedFired.current = false;
        }
        saleRef.current = next;
        refPayco.current = null;
        hooksLogged.current = new Set();
        persist(next);
        setSale(next);
        setQr(null);
        // Si los precios cambiaron desde que se armó el carrito, se avisa antes de cobrar (la ventana todavía no se abre)
        if (!cur && o.expectedTotal !== undefined && Math.abs(next.total - o.expectedTotal) > 0.01) setPhase("confirm_total");
        else begin(next);
      } catch {
        setError("No se pudo conectar. Intente de nuevo.");
        if (phaseRef.current === "creating") setPhase("choose");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [begin, o, persist, setPhase]
  );

  useEffect(() => {
    chooseRef.current = choose;
  }, [choose]);

  const confirmTotal = useCallback(() => {
    if (saleRef.current) begin(saleRef.current);
  }, [begin]);

  /** Desde el QR: volver a elegir (el intento QR abierto se reemplaza) */
  const changeMethod = useCallback(() => {
    replaceNext.current = true;
    setError("");
    setPhase("choose");
  }, [setPhase]);

  /** "Sí, ya pagué (esperar)": pasa a "en proceso" y sigue consultando */
  const saidPaid = useCallback(() => {
    setPhase("in_process");
  }, [setPhase]);

  /** "No, intentar de nuevo" (sin evidencia de pago): vuelve a la elección; el servidor rechaza si apareció evidencia mientras tanto */
  const notPaid = useCallback(() => {
    replaceNext.current = true;
    setError("");
    setPhase("choose");
  }, [setPhase]);

  /** "Intentar de nuevo" tras cancelado/rechazado: vuelve a la pantalla de elección */
  const retry = useCallback(() => {
    setError("");
    setPhase("choose");
  }, [setPhase]);

  /** "Cancelar compra": avisa al servidor (idempotente). Con un pago pendiente la venta queda para revisión, nunca se pierde. */
  const cancel = useCallback(async (opts: { keep?: boolean } = {}): Promise<{ keptForReview: boolean }> => {
    const s = saleRef.current;
    let kept = false;
    if (s) {
      setCancelling(true);
      try {
        const r = await fetch(`/api/kiosco/pagos/${s.id}/cancelar`, { method: "POST", headers: json, body: JSON.stringify({ keep: opts.keep === true }) });
        const d = await r.json().catch(() => ({}));
        kept = !!d.kept_for_review;
      } catch {
        /* sin conexión: la venta vence sola */
      } finally {
        setCancelling(false);
      }
    }
    persist(null);
    return { keptForReview: kept };
  }, [persist]);

  /** Borra TODO el estado de pago de esta pantalla (reinicio por inactividad, nueva compra…) */
  const reset = useCallback(() => {
    saleRef.current = null;
    refPayco.current = null;
    reopen.current = null;
    hooksLogged.current = new Set();
    replaceNext.current = false;
    saleClosedRef.current = false;
    invoicedFired.current = false;
    persist(null);
    setSale(null);
    setInvoice(null);
    setQr(null);
    setError("");
    setBusy(false);
    setCancelling(false);
    busyRef.current = false;
    setSaleClosed(false);
    setAttemptInfo(null);
    setPhase("choose");
  }, [persist, setPhase]);

  /** Caja: el cajero pega la referencia larga (o el enlace de ePayco con ref_payco=…) y el servidor la verifica */
  const verifyRef = useCallback(
    async (text: string): Promise<string> => {
      const s = saleRef.current;
      if (!s) return "No hay un cobro en curso.";
      const ref = /ref_payco=([A-Za-z0-9_-]{4,64})/.exec(text)?.[1] ?? (/^[A-Za-z0-9_-]{4,64}$/.test(text.trim()) ? text.trim() : null);
      if (!ref) return "Pegue la referencia o el enlace completo que muestra ePayco (contiene ref_payco=…).";
      try {
        const r = await fetch(`/api/kiosco/pagos/${s.id}/verificar`, { method: "POST", headers: json, body: JSON.stringify({ ref_payco: ref }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return d.error ?? "No se pudo verificar esa referencia.";
        refPayco.current = ref;
        if (phaseRef.current === "window" || phaseRef.current === "qr") setPhase("verifying");
        applyState(d as ServerState);
        return "Verificando con ePayco…";
      } catch {
        return "Sin conexión. Intente de nuevo.";
      }
    },
    [applyState, setPhase]
  );

  // ---------------------------------------------------------------- cuenta regresiva y QR
  useEffect(() => {
    if (!sale || !["qr", "window", "verifying", "in_process"].includes(phase)) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((new Date(sale.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [phase, sale]);

  const payUrl = sale?.channel === "qr" ? sale.payUrl ?? null : null;
  useEffect(() => {
    if (!payUrl) return;
    let alive = true;
    QRCode.toDataURL(payUrl, { margin: 1, width: 320 })
      .then((u) => alive && setQr(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [payUrl]);

  useEffect(() => {
    evidenceRef.current = !!attemptInfo?.evidence;
  }, [attemptInfo]);

  const mmss = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;
  return {
    phase, sale, error, busy, invoice, qr, mmss, cancelling, saleClosed, attemptInfo,
    choose, confirmTotal, changeMethod, retry, cancel, reset, verifyRef, saidPaid, notPaid,
    /** vuelve a abrir la ventana de ePayco (solo la usa la caja con el cobro pegado a mano; el flujo normal NO la ofrece) */
    reopenWindow: () => (reopen.current ? reopen.current() : undefined),
  };
}
