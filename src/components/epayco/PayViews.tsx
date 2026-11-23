"use client";

// Pantallas COMPARTIDAS del cobro electrónico (ePayco). Las usan el kiosco (grandes, táctiles) y la caja (dentro del modal).
// Solo dibujan: la lógica (intentos, verificación, estados) vive en useEpaycoPayment.ts y en el servidor.
import { useState } from "react";
import { formatCOP } from "@/lib/money";

export type Size = "kiosk" | "pos";

const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(" ");

export function Spinner({ size }: { size: Size }) {
  return <div role="status" aria-label="Cargando" className={cx("border-field border-t-brand rounded-full animate-spin", size === "kiosk" ? "w-16 h-16 border-8" : "w-10 h-10 border-4")} />;
}

/** Recuadro con icono (no texto pequeño): el QR se escanea con la CÁMARA del celular, no desde la app del banco. */
export function CameraWarning({ size }: { size: Size }) {
  const k = size === "kiosk";
  return (
    <div role="note" className={cx("flex items-start gap-3 rounded-xl border-2 border-warn-line bg-warn-soft text-warn-ink text-left", k ? "px-5 py-4" : "px-3 py-2.5")}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className={cx("shrink-0", k ? "w-9 h-9" : "w-6 h-6")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <p className={cx("font-bold leading-snug", k ? "text-[19px]" : "text-[14px]")}>Escanee con la cámara del celular, NO desde la app de su banco.</p>
    </div>
  );
}

/**
 * "¿Cómo desea pagar?" Dos botones del MISMO tamaño y peso visual (no se prioriza ninguno). No se crea ninguna sesión de ePayco ni se abre
 * ninguna ventana hasta que se elige un botón.
 */
export function PayChoice(p: {
  size: Size;
  /** kiosco: lo elige el cliente · caja: lo elige el cajero */
  who: "cliente" | "cajero";
  total: number;
  qrAvailable: boolean;
  busy?: boolean;
  error?: string;
  test?: boolean;
  onQr: () => void;
  onScreen: () => void;
  onBack?: () => void;
  onCancel: () => void;
  /** texto extra (p. ej. "Intento 2") */
  note?: string;
}) {
  const k = p.size === "kiosk";
  const caja = p.who === "cajero";
  const btn = cx(
    "w-full rounded-2xl border-2 border-brand bg-surface text-brand-text hover:bg-brand-soft active:bg-brand-soft disabled:opacity-50 disabled:hover:bg-surface flex flex-col items-center justify-center text-center",
    k ? "h-full min-h-52 px-6 py-6 gap-2" : "h-full min-h-32 px-4 py-4 gap-1"
  );
  const title = cx("font-extrabold leading-tight", k ? "text-2xl sm:text-3xl" : "text-[18px]");
  const help = cx("font-medium text-body", k ? "text-lg sm:text-xl" : "text-[13px]");
  return (
    <div className={cx("w-full mx-auto space-y-5", k ? "max-w-4xl" : "max-w-xl")}>
      {p.test && <div className="rounded-xl bg-warn-soft border border-warn-line text-warn-ink px-4 py-2 font-semibold text-center">MODO DE PRUEBA: no se cobra dinero real</div>}
      <div className="text-center">
        <h1 className={cx("font-bold text-fg", k ? "text-4xl" : "text-xl")}>{caja ? "¿Cómo se va a cobrar?" : "¿Cómo desea pagar?"}</h1>
        <div className={cx("font-extrabold text-brand-text", k ? "text-5xl mt-2" : "text-3xl mt-1")}>{formatCOP(p.total)}</div>
        {p.note && <div className="text-dim text-[14px] mt-1">{p.note}</div>}
      </div>
      {/* Dos columnas con filas compartidas (subgrid): los dos botones miden EXACTAMENTE lo mismo; la advertencia va bajo el del QR */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 sm:grid-rows-[auto_auto]">
        <div className="sm:row-span-2 grid sm:grid-rows-subgrid gap-3">
          <button type="button" onClick={p.onQr} disabled={p.busy || !p.qrAvailable} className={btn}>
            <span className={title}>{caja ? "Mostrar QR al cliente" : "Pagar con mi celular (QR)"}</span>
            <span className={help}>{p.qrAvailable ? (caja ? "El cliente escanea el código con la cámara de su celular." : "Escanee el código con la CÁMARA de su celular.") : "No disponible en este equipo."}</span>
          </button>
          {p.qrAvailable ? <CameraWarning size={p.size} /> : <div />}
        </div>
        <div className="sm:row-span-2 grid sm:grid-rows-subgrid gap-3">
          <button type="button" onClick={p.onScreen} disabled={p.busy} className={btn}>
            <span className={title}>{caja ? "Cobrar en esta pantalla" : "Pagar en esta pantalla (tarjeta o PSE)"}</span>
            <span className={help}>Se abrirá la ventana segura de ePayco.</span>
          </button>
          <div />
        </div>
      </div>
      {p.busy && (
        <div className="flex justify-center">
          <Spinner size={p.size} />
        </div>
      )}
      {p.error && <p className={cx("text-err-ink bg-err-soft rounded-xl p-3 text-center", k ? "text-[18px]" : "text-[14px]")} role="alert">{p.error}</p>}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {p.onBack && (
          <button type="button" onClick={p.onBack} disabled={p.busy} className={cx("min-h-12 px-6 rounded-xl border border-field bg-surface text-body font-medium disabled:opacity-50", k ? "text-xl" : "text-[14px]")}>
            ← Volver
          </button>
        )}
        <button type="button" onClick={p.onCancel} disabled={p.busy} className={cx("min-h-12 px-6 rounded-xl text-brand-text underline font-medium disabled:opacity-50", k ? "text-xl" : "text-[14px]")}>
          Cancelar compra
        </button>
      </div>
    </div>
  );
}

/** QR del enlace de pago + la misma advertencia. */
export function QrScan(p: { size: Size; qr: string | null; local: string; total: number; mmss: string; /** el enlace ya se abrió en un celular */ opened?: boolean }) {
  const k = p.size === "kiosk";
  return (
    <div className={cx("w-full mx-auto space-y-4 text-center", k ? "max-w-2xl" : "max-w-md")}>
      <h1 className={cx("font-bold text-fg", k ? "text-3xl" : "text-lg")}>Escanee el código con la cámara de su celular</h1>
      <div className={cx("font-extrabold text-brand-text", k ? "text-5xl" : "text-3xl")}>{formatCOP(p.total)}</div>
      <div className="inline-block rounded-2xl bg-white p-4 border border-line">
        {p.qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.qr} alt="QR para pagar desde el celular" className={cx("max-w-full", k ? "w-64 h-64" : "w-52 h-52")} />
        ) : (
          <div className={cx("max-w-full grid place-items-center text-gray-600", k ? "w-64 h-64" : "w-52 h-52")}>Generando el código…</div>
        )}
      </div>
      <CameraWarning size={p.size} />
      {p.opened && (
        <p role="alert" className={cx("rounded-xl border-2 border-brand-line bg-brand-soft text-brand-ink font-bold px-4 py-3", k ? "text-[19px]" : "text-[14px]")}>
          Este pago se abrió en un celular. Termine el pago allí o cancele la compra.
        </p>
      )}
      <p className={cx("text-soft", k ? "text-[18px]" : "text-[13px]")}>
        Compra <b>{p.local}</b> · Tiempo restante <b>{p.mmss}</b>
      </p>
      <p className={cx("font-semibold text-body", k ? "text-[19px]" : "text-[14px]")}>Termine el pago en su celular; si pagó por PSE puede tardar unos minutos.</p>
      <p className={cx("text-dim", k ? "text-[16px]" : "text-[13px]")}>Esta pantalla se actualiza sola cuando el pago sea aprobado.</p>
    </div>
  );
}

/** "Verificando su pago con ePayco…": sin reintentos; solo un "Cancelar compra" deshabilitado mientras se verifica. */
export function VerifyingView({ size }: { size: Size }) {
  const k = size === "kiosk";
  return (
    <div className="flex flex-col items-center gap-5 text-center" role="status" aria-live="polite">
      <Spinner size={size} />
      <h1 className={cx("font-bold text-fg", k ? "text-3xl" : "text-lg")}>Verificando su pago con ePayco…</h1>
      <p className={cx("text-soft max-w-xl", k ? "text-xl" : "text-[14px]")}>Un momento, no cierre esta pantalla ni vuelva a pagar.</p>
      <button type="button" disabled className={cx("min-h-12 px-8 rounded-xl border border-field text-body bg-surface opacity-50", k ? "text-xl" : "text-[14px]")}>
        Cancelar compra
      </button>
    </div>
  );
}

/** "Su pago está en proceso" (típico de PSE): NO se puede repetir el pago. Solo "Seguir esperando" y "Cancelar compra" (con aviso). */
export function InProcessView(p: { size: Size; local: string; mmss: string; onWait: () => void; onCancel: () => void; cancelling?: boolean }) {
  const k = p.size === "kiosk";
  const [ask, setAsk] = useState(false);
  const [waiting, setWaiting] = useState(false);
  return (
    <div className="flex flex-col items-center gap-5 text-center max-w-2xl mx-auto" role="status" aria-live="polite">
      <Spinner size={p.size} />
      <h1 className={cx("font-bold text-fg", k ? "text-4xl" : "text-xl")}>Su pago está en proceso</h1>
      <p className={cx("text-soft", k ? "text-2xl" : "text-[15px]")}>No lo repita. Estamos esperando la confirmación de su banco.</p>
      {/* Sin contador: con un pago en curso el cobro no termina en "fallido" por tiempo (queda por confirmar) */}
      <p className={cx("text-dim", k ? "text-[18px]" : "text-[13px]")}>
        Compra <b>{p.local}</b> · Con PSE la confirmación puede tardar unos minutos. Esta pantalla avanza sola.
      </p>
      {waiting && !ask && <p className={cx("text-ok-ink font-semibold", k ? "text-xl" : "text-[14px]")}>Seguimos esperando la confirmación…</p>}
      {!ask ? (
        <div className="flex flex-wrap justify-center gap-4">
          <button
            type="button"
            onClick={() => {
              setWaiting(true);
              p.onWait();
            }}
            className={cx("min-h-12 px-8 rounded-xl bg-brand text-white font-semibold", k ? "text-xl py-4" : "text-[14px]")}
          >
            Seguir esperando
          </button>
          <button type="button" onClick={() => setAsk(true)} className={cx("min-h-12 px-8 rounded-xl border border-field text-body bg-surface font-medium", k ? "text-xl py-4" : "text-[14px]")}>
            Cancelar compra
          </button>
        </div>
      ) : (
        <div className="w-full rounded-xl border-2 border-warn-line bg-warn-soft text-warn-ink px-5 py-4 space-y-3">
          <p className={cx("font-bold", k ? "text-xl" : "text-[14px]")}>Si ya realizó el pago, no se perderá: quedará registrado para revisión.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <button type="button" onClick={() => setAsk(false)} disabled={p.cancelling} className={cx("min-h-12 px-6 rounded-xl border border-field bg-surface text-body font-medium disabled:opacity-50", k ? "text-xl" : "text-[14px]")}>
              Volver
            </button>
            <button type="button" onClick={p.onCancel} disabled={p.cancelling} className={cx("min-h-12 px-6 rounded-xl bg-err text-white font-bold disabled:opacity-50", k ? "text-xl" : "text-[14px]")}>
              {p.cancelling ? "Cancelando…" : "Sí, cancelar compra"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "No recibimos confirmación de su pago. ¿Completó el pago?" — solo cuando NO hay ninguna evidencia de pago en curso. Dos botones del
 * mismo tamaño: "Sí, ya pagué (esperar)" (pasa a "en proceso" y sigue consultando) y "No, intentar de nuevo" (otro intento).
 */
export function NoConfirmationView(p: { size: Size; local: string; mmss: string; onPaid: () => void; onRetry: () => void; onCancel: () => void; busy?: boolean; error?: string }) {
  const k = p.size === "kiosk";
  const big = cx("flex-1 min-h-14 rounded-2xl border-2 border-brand bg-surface text-brand-text font-extrabold hover:bg-brand-soft disabled:opacity-50", k ? "text-2xl px-6 py-5" : "text-[16px] px-4 py-3");
  return (
    <div className="flex flex-col items-center gap-5 text-center max-w-3xl mx-auto w-full">
      <div className={cx("text-warn-ink", k ? "text-7xl" : "text-5xl")} aria-hidden="true">?</div>
      <h1 className={cx("font-bold text-fg", k ? "text-4xl" : "text-xl")}>No recibimos confirmación de su pago</h1>
      <p className={cx("text-soft", k ? "text-2xl" : "text-[15px]")}>¿Completó el pago?</p>
      <p className={cx("text-dim", k ? "text-[18px]" : "text-[13px]")}>
        Compra <b>{p.local}</b> · Tiempo restante <b>{p.mmss}</b>
      </p>
      <div className="flex flex-col sm:flex-row gap-4 w-full">
        <button type="button" onClick={p.onPaid} disabled={p.busy} className={big}>
          Sí, ya pagué (esperar)
        </button>
        <button type="button" onClick={p.onRetry} disabled={p.busy} className={big}>
          No, intentar de nuevo
        </button>
      </div>
      {p.error && <p className={cx("text-err-ink bg-err-soft rounded-xl p-3", k ? "text-[18px]" : "text-[14px]")} role="alert">{p.error}</p>}
      <button type="button" onClick={p.onCancel} disabled={p.busy} className={cx("min-h-12 px-8 rounded-xl border border-field text-body bg-surface font-medium disabled:opacity-50", k ? "text-xl" : "text-[14px]")}>
        Cancelar compra
      </button>
    </div>
  );
}

/** "Pago cancelado": lo hizo el cliente, no el banco. */
export function CancelledView(p: { size: Size; onRetry: () => void; onCancel: () => void; busy?: boolean }) {
  const k = p.size === "kiosk";
  return (
    <div className="flex flex-col items-center gap-4 text-center max-w-2xl mx-auto">
      <div className={cx("text-warn-ink", k ? "text-7xl" : "text-5xl")} aria-hidden="true">!</div>
      <h1 className={cx("font-bold text-fg", k ? "text-4xl" : "text-xl")}>Pago cancelado</h1>
      <p className={cx("text-soft", k ? "text-2xl" : "text-[15px]")}>Usted canceló el pago. No se hizo ningún cobro.</p>
      <div className="flex flex-wrap justify-center gap-4 pt-2">
        <button type="button" onClick={p.onRetry} disabled={p.busy} className={cx("min-h-12 px-8 rounded-xl bg-brand text-white font-semibold disabled:opacity-50", k ? "text-xl py-4" : "text-[14px]")}>
          Intentar de nuevo
        </button>
        <button type="button" onClick={p.onCancel} disabled={p.busy} className={cx("min-h-12 px-8 rounded-xl border border-field text-body bg-surface font-medium disabled:opacity-50", k ? "text-xl py-4" : "text-[14px]")}>
          Cancelar compra
        </button>
      </div>
    </div>
  );
}

/** "El pago fue rechazado" (banco o entidad). */
export function RejectedView(p: { size: Size; who: "cliente" | "cajero"; message?: string; onRetry: () => void; onCancel: () => void; busy?: boolean }) {
  const k = p.size === "kiosk";
  return (
    <div className="flex flex-col items-center gap-4 text-center max-w-2xl mx-auto">
      <div className={cx("text-err-ink", k ? "text-7xl" : "text-5xl")} aria-hidden="true">✕</div>
      <h1 className={cx("font-bold text-fg", k ? "text-4xl" : "text-xl")}>El pago fue rechazado</h1>
      <p className={cx("text-soft", k ? "text-2xl" : "text-[15px]")}>
        {p.message ?? (p.who === "cajero" ? "El cliente puede intentarlo de nuevo o pagar con otro medio." : "Puede intentarlo de nuevo con otro medio de pago.")}
      </p>
      <div className="flex flex-wrap justify-center gap-4 pt-2">
        <button type="button" onClick={p.onRetry} disabled={p.busy} className={cx("min-h-12 px-8 rounded-xl bg-brand text-white font-semibold disabled:opacity-50", k ? "text-xl py-4" : "text-[14px]")}>
          Intentar de nuevo
        </button>
        <button type="button" onClick={p.onCancel} disabled={p.busy} className={cx("min-h-12 px-8 rounded-xl border border-field text-body bg-surface font-medium disabled:opacity-50", k ? "text-xl py-4" : "text-[14px]")}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
