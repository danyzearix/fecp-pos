"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCOP } from "@/lib/money";

/** Lo que el servidor responde al kiosco: SOLO datos enmascarados (nunca el nombre, correo ni teléfono reales) */
type Lookup = { found: true; name_masked: string; identification_masked: string } | { found: false };

export type CedulaChoice =
  | { mode: "cf" } // Consumidor final
  | { mode: "existing"; identification: string } // "Sí, soy yo": el navegador solo manda el número; el servidor vuelve a buscar al cliente
  | { mode: "new"; identification: string }; // "Factura electrónica a mi nombre": formulario en blanco

type Props = {
  total: number;
  /** con CONSUMIDOR_FINAL_SIN_TOPE=false y una compra de más de 5 UVT no se ofrece Consumidor final */
  cfAllowed: boolean;
  onBack: () => void;
  onChoose: (c: CedulaChoice) => void;
};

const MAX_DIGITS = 15;
const bigBtn = "min-h-16 rounded-2xl text-2xl font-bold";

/**
 * Paso "Ingrese su número de cédula" del kiosco. Teclado numérico grande, número COMPLETO (sin búsqueda parcial ni autocompletado
 * mientras escribe). Todo el estado vive solo en este componente: al salir de la pantalla (o por inactividad) desaparece.
 */
export default function CedulaStep({ total, cfAllowed, onBack, onChoose }: Props) {
  const [digits, setDigits] = useState("");
  const [phase, setPhase] = useState<"input" | "searching" | "found" | "notfound">("input");
  const [result, setResult] = useState<Lookup | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const press = useCallback(
    (d: string) => {
      if (phase !== "input") return;
      setError("");
      setDigits((p) => (p.length >= MAX_DIGITS ? p : p + d));
    },
    [phase]
  );
  const erase = useCallback(() => phase === "input" && setDigits((p) => p.slice(0, -1)), [phase]);

  async function consult() {
    if (digits.length < 5 || phase !== "input") return;
    setError("");
    setPhase("searching");
    try {
      const res = await fetch("/api/kiosco/cliente", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identification: digits }) });
      const d = (await res.json().catch(() => ({}))) as Lookup & { error?: string };
      if (!alive.current) return;
      if (res.status === 429) {
        setPhase("input");
        return setError(d.error ?? "Demasiadas consultas. Acérquese a la caja.");
      }
      if (!res.ok) {
        setPhase("input");
        return setError("No se pudo consultar. Intente de nuevo.");
      }
      setResult(d);
      setPhase(d.found ? "found" : "notfound");
    } catch {
      if (!alive.current) return;
      setPhase("input");
      setError("No se pudo conectar. Intente de nuevo.");
    }
  }

  // Teclado físico (lector o teclado conectado al kiosco): solo dígitos, Borrar y Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== "input") return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") erase();
      else if (e.key === "Enter") void consult();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const restart = () => {
    setDigits("");
    setResult(null);
    setError("");
    setPhase("input");
  };

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-fg">Ingrese su número de cédula</h1>
          <p className="text-[17px] text-soft mt-1">
            Total a pagar: <b className="text-fg">{formatCOP(total)}</b>
          </p>
        </div>

        {(phase === "input" || phase === "searching") && (
          <>
            <div
              className="rounded-2xl border-2 border-field bg-surface px-5 py-5 text-center text-4xl font-bold tracking-[0.2em] text-fg min-h-20 flex items-center justify-center"
              aria-live="polite"
              aria-label="Número de cédula"
            >
              {digits || <span className="text-faint text-2xl tracking-normal font-medium">Toque los números</span>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} onClick={() => press(d)} disabled={phase === "searching"} className={`${bigBtn} bg-surface border border-field text-fg active:bg-hover`} aria-label={d}>
                  {d}
                </button>
              ))}
              <button onClick={() => setDigits("")} disabled={phase === "searching"} className={`${bigBtn} bg-surface border border-field text-body text-xl active:bg-hover`}>
                Borrar todo
              </button>
              <button onClick={() => press("0")} disabled={phase === "searching"} className={`${bigBtn} bg-surface border border-field text-fg active:bg-hover`} aria-label="0">
                0
              </button>
              <button onClick={erase} disabled={phase === "searching"} className={`${bigBtn} bg-surface border border-field text-body active:bg-hover`} aria-label="Borrar un número">
                ⌫
              </button>
            </div>
            {error && <p className="text-[17px] text-err-ink bg-err-soft rounded-xl p-4" role="alert">{error}</p>}
            <p className="text-[14px] text-dim">Escriba el número completo. Si la factura es para una empresa, escriba el NIT sin el dígito de verificación.</p>
            <div className="flex gap-4">
              <button onClick={onBack} className="px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
                ← Volver
              </button>
              <button
                onClick={consult}
                disabled={digits.length < 5 || phase === "searching"}
                className="flex-1 py-4 min-h-16 rounded-xl bg-go hover:bg-go-hover text-white text-2xl font-bold disabled:opacity-50"
              >
                {phase === "searching" ? "Consultando…" : "Consultar"}
              </button>
            </div>
            {cfAllowed && (
              <button onClick={() => onChoose({ mode: "cf" })} disabled={phase === "searching"} className="min-h-12 px-2 text-[16px] text-brand-text underline">
                No quiero dar mi cédula (Consumidor final)
              </button>
            )}
          </>
        )}

        {phase === "found" && result?.found && (
          <div className="space-y-5">
            <div className="rounded-2xl border-2 border-brand-line bg-brand-soft px-6 py-6 text-center">
              <div className="text-xl text-brand-ink font-semibold mb-3">¿Es usted?</div>
              <div className="text-4xl font-extrabold text-fg tracking-wide">{result.name_masked}</div>
              <div className="text-2xl text-body mt-2 tracking-widest">{result.identification_masked}</div>
            </div>
            <p className="text-[15px] text-soft">
              Por protección de datos personales (Ley 1581 de 2012) solo mostramos una parte de sus datos. Si confirma, la factura saldrá a ese nombre.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <button onClick={restart} className={`${bigBtn} px-8 border border-field bg-surface text-body`}>
                No, corregir
              </button>
              <button onClick={() => onChoose({ mode: "existing", identification: digits })} className={`${bigBtn} flex-1 bg-go hover:bg-go-hover text-white`}>
                Sí, soy yo
              </button>
            </div>
          </div>
        )}

        {phase === "notfound" && (
          <div className="space-y-5">
            <div className="rounded-2xl border border-line bg-subtle px-6 py-6 text-center">
              <div className="text-2xl font-bold text-fg">No encontramos esa cédula</div>
              <div className="text-lg text-soft mt-1">Puede pagar como Consumidor final o pedir la factura electrónica a su nombre.</div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {cfAllowed && (
                <button onClick={() => onChoose({ mode: "cf" })} className={`${bigBtn} border-2 border-field bg-surface text-body`}>
                  Consumidor final
                </button>
              )}
              <button onClick={() => onChoose({ mode: "new", identification: digits })} className={`${bigBtn} bg-brand text-white ${cfAllowed ? "" : "sm:col-span-2"}`}>
                Factura electrónica a mi nombre
              </button>
            </div>
            <button onClick={restart} className="min-h-12 px-2 text-[16px] text-brand-text underline">
              ← Escribir otro número
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
