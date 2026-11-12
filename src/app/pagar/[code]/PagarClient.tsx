"use client";

// Pantalla PÚBLICA de pago (sin sesión), para el celular del cliente: /pagar/<código> y /pagar/<código>/respuesta.
// Solo muestra lo mínimo (compra, total, estado). Nunca marca nada como pagado por lo que diga el navegador: el servidor
// verifica el ref_payco con ePayco y esta pantalla solo refleja el estado que el servidor guarda.
import { useCallback, useEffect, useRef, useState } from "react";
import Logo from "@/components/Logo";
import { findRef, openOnpageCheckout } from "@/components/kiosco/epayco-client";
import { formatCOP } from "@/lib/money";

export type PublicInfo = {
  local_number: string;
  total: number;
  status: string;
  invoice_name: string | null;
  can_pay: boolean;
  message: string;
  test: boolean;
  expires_at: string | null;
};

const json = { "Content-Type": "application/json" };
const WAITING = ["esperando_pago"];
const PROCESSING = ["pagado", "pending", "invoicing"];

export default function PagarClient({ code, mode, initial }: { code: string; mode: "pagar" | "respuesta"; initial: PublicInfo }) {
  const [info, setInfo] = useState<PublicInfo>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const refPayco = useRef<string | null>(null); // solo una PISTA: el servidor la verifica con ePayco
  const lastConfirm = useRef(0);
  const tickBusy = useRef(false);

  // Al volver de ePayco (?ref_payco=...) se toma la referencia y se limpia la URL
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ref = (q.get("ref_payco") || q.get("x_ref_payco") || "").trim();
    if (ref) {
      refPayco.current = ref;
      history.replaceState(null, "", location.pathname);
    }
  }, []);

  // Mensajes del checkout de ePayco (solo de sus dominios): pueden traer el ref_payco
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      try {
        const host = new URL(e.origin).hostname;
        if (!/(^|\.)(epayco\.(co|io)|davipay\.com)$/.test(host)) return;
      } catch {
        return;
      }
      const ref = findRef(e.data);
      if (ref) refPayco.current = ref;
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const waiting = WAITING.includes(info.status);
  const processing = PROCESSING.includes(info.status);

  // Cada 3 s: si hay ref_payco se le pide al servidor que lo verifique (como mucho cada 8 s); si no, se lee el estado
  useEffect(() => {
    if (!waiting && !processing) return;
    const tick = async () => {
      if (tickBusy.current) return;
      tickBusy.current = true;
      try {
        if (waiting && refPayco.current && Date.now() - lastConfirm.current > 8000) {
          lastConfirm.current = Date.now();
          await fetch(`/api/pagar/${code}/confirmar`, { method: "POST", headers: json, body: JSON.stringify({ ref_payco: refPayco.current }) });
        }
        const r = await fetch(`/api/pagar/${code}`, { cache: "no-store" });
        if (r.ok) setInfo((await r.json()) as PublicInfo);
      } catch {
        /* se reintenta en 3 s */
      } finally {
        tickBusy.current = false;
      }
    };
    void tick();
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [code, waiting, processing]);

  const pay = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/pagar/${code}/sesion`, { method: "POST", headers: json });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error ?? "No se pudo iniciar el pago");
        return;
      }
      await openOnpageCheckout(d.session_id, !!d.test, {
        onPayload: (_hook, payload) => {
          const ref = findRef(payload);
          if (ref) refPayco.current = ref;
        },
      });
      setOpened(true);
    } catch {
      setError("No se pudo abrir la ventana de pago. Intente de nuevo.");
    } finally {
      setBusy(false);
    }
  }, [code]);

  const ok = info.status === "invoiced";
  const warn = ["failed", "revisar", "pago_por_revisar", "pago_tardio"].includes(info.status);
  const bad = ["pago_fallido", "anulada"].includes(info.status);

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-app">
      <div className="w-full max-w-[440px] bg-surface rounded-2xl shadow-lg border border-line p-6 text-center text-fg space-y-4">
        <Logo className="h-12 w-20 mx-auto" />
        <div className="text-[13px] text-dim">Compra {info.local_number}</div>
        <div className="text-4xl font-extrabold">{formatCOP(info.total)}</div>

        {info.test && (
          <div className="rounded-lg bg-warn-soft border border-warn-line text-warn-ink text-[13px] px-3 py-2">MODO DE PRUEBA: no se cobra dinero real.</div>
        )}

        {(ok || warn || bad) && (
          <div className={`text-5xl ${ok ? "text-ok-ink" : warn ? "text-warn-ink" : "text-err-ink"}`}>{ok ? "✓" : warn ? "!" : "✕"}</div>
        )}
        {processing && <div className="mx-auto w-10 h-10 rounded-full border-4 border-line border-t-brand animate-spin" />}

        <p className="text-[16px] font-medium">{info.message}</p>
        {ok && info.invoice_name && <p className="text-xl font-bold">Factura {info.invoice_name}</p>}

        {waiting && info.can_pay && (
          <div className="space-y-2">
            <button onClick={() => void pay()} disabled={busy} className="w-full px-6 py-4 rounded-xl bg-brand text-white text-lg font-bold disabled:opacity-50">
              {busy ? "Abriendo…" : opened ? "Abrir el pago de nuevo" : "Pagar ahora"}
            </button>
            <p className="text-[12px] text-dim">Pago seguro con ePayco (tarjetas, PSE, Nequi y más).</p>
          </div>
        )}
        {waiting && !info.can_pay && <p className="text-[14px] text-dim">El tiempo para pagar se agotó.</p>}
        {error && <p className="text-[14px] text-err-ink">{error}</p>}

        {mode === "respuesta" && info.status === "pago_fallido" && (
          <a href={`/pagar/${code}`} className="inline-block text-[14px] text-brand-text underline">
            Volver al enlace de pago
          </a>
        )}
      </div>
    </main>
  );
}
