"use client";

// Botón «Sincronizar productos de Siigo» (junto al de WooCommerce): recorre TODOS los productos y TODAS las bodegas de Siigo.
// Corre en segundo plano en el servidor; aquí se ve el progreso y, al final, el resumen. Un solo candado con WooCommerce.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Summary = {
  kind: string; total_siigo: number; creados: number; actualizados: number; unidos: number; omitidos_inactivos: number; omitidos_tipo: number;
  omitidos_sin_precio: number; omitidos_tarifa: number; ambiguos: number; ambiguos_detalle: string[]; errores: number; errores_detalle: string[];
  desactivados: number; bodegas: number; existencias_filas: number; peticiones: number; iva_distinto: number; precio_distinto: number;
  unidos_inactivos_en_siigo: number; lista_de_precios: string;
};
type Run = { id: number; kind: string; trigger: string; status: "running" | "done" | "error"; started_at: string; finished_at: string | null; progress: { page?: number; pages?: number; products?: number; total?: number } | null; summary: Summary | null; error: string | null };
type Status = { running: Run | null; last: Run | null; lastFull: Run | null; lastStock: Run | null; counts: { total: number; woocommerce: number; siigo: number; ambos: number; ambiguos: number; con_existencias: number } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" }) : "nunca");

export default function SiigoSync() {
  const router = useRouter();
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/productos/siigo", { cache: "no-store" });
    if (res.ok) setSt((await res.json()) as Status);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const running = !!st?.running;
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        router.refresh(); // terminó: la tabla de abajo se actualiza
      }
      return;
    }
    wasRunning.current = true;
    const iv = setInterval(() => void load(), 2000);
    return () => clearInterval(iv);
  }, [running, load, router]);

  async function start(kind: "completa" | "existencias") {
    setStarting(true);
    setError("");
    try {
      const res = await fetch("/api/admin/productos/siigo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error ?? `Error ${res.status}`);
      await load();
    } catch {
      setError("Sin conexión con el servidor");
    } finally {
      setStarting(false);
    }
  }

  const r = st?.running;
  const pct = r?.progress?.pages ? Math.min(100, Math.round(((r.progress.page ?? 0) / r.progress.pages) * 100)) : 0;
  const last = st?.last && st.last.status !== "running" ? st.last : null;
  const sum = last?.summary ?? null;

  return (
    <div className="space-y-3" data-testid="siigo-sync">
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => void start("completa")}
          disabled={running || starting}
          className="bg-brand text-white text-base font-semibold rounded-lg px-5 min-h-11 disabled:opacity-60"
        >
          {running ? "Sincronizando Siigo…" : "Sincronizar productos de Siigo"}
        </button>
        <button
          onClick={() => void start("existencias")}
          disabled={running || starting}
          className="border border-brand text-brand-text text-base font-semibold rounded-lg px-4 min-h-11 disabled:opacity-60"
        >
          Solo existencias
        </button>
      </div>
      {error && <p className="text-base text-err-ink bg-err-soft rounded-lg p-3">{error}</p>}

      {r && (
        <div className="rounded-lg border border-line bg-subtle p-3 space-y-2" role="status" aria-live="polite">
          <div className="text-[14px] text-fg">
            {r.kind === "completa" ? "Sincronización completa" : "Existencias"} en curso · página {r.progress?.page ?? 0} de {r.progress?.pages ?? "…"} · {r.progress?.products ?? 0} productos leídos
          </div>
          <div className="h-3 rounded-full bg-line overflow-hidden"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
          <p className="text-[12px] text-dim">Máximo 80 peticiones por minuto a Siigo. La caja y la facturación siguen funcionando.</p>
        </div>
      )}

      {last && last.status === "error" && (
        <p className="text-[14px] text-err-ink bg-err-soft rounded-lg p-3">La última sincronización ({when(last.started_at)}) falló: {last.error}</p>
      )}

      {sum && last?.status === "done" && (
        <div className="text-[14px] bg-ok-soft text-ok-ink rounded-lg p-3 space-y-1" data-testid="siigo-sync-summary">
          <div>
            <b>{last.kind === "completa" ? "Sincronización completa" : "Existencias"}</b> · {when(last.finished_at)} · {sum.total_siigo} productos leídos de Siigo, {sum.bodegas} bodegas, {sum.existencias_filas} existencias.
          </div>
          {last.kind === "completa" && (
            <>
              <div>
                <b>{sum.creados}</b> creados · <b>{sum.actualizados}</b> actualizados · <b>{sum.unidos}</b> unidos con WooCommerce · <b>{sum.omitidos_inactivos + sum.omitidos_tipo + sum.omitidos_sin_precio + sum.omitidos_tarifa}</b> omitidos
                ({sum.omitidos_inactivos} inactivos, {sum.omitidos_tipo} servicios u otros tipos{sum.omitidos_sin_precio ? `, ${sum.omitidos_sin_precio} sin precio` : ""}{sum.omitidos_tarifa ? `, ${sum.omitidos_tarifa} con IVA no soportado` : ""}) · <b>{sum.ambiguos}</b> ambiguos · <b>{sum.errores}</b> con error · {sum.desactivados} desactivados
              </div>
              {(sum.iva_distinto > 0 || sum.precio_distinto > 0) && (
                <div className="text-warn-ink">
                  ⚠ De los unidos, {sum.iva_distinto} tienen IVA distinto y {sum.precio_distinto} precio distinto entre WooCommerce y Siigo (no se cambiaron; lista de precios de Siigo usada: «{sum.lista_de_precios}»). El detalle del IVA: <code>npm run report:iva</code>.
                </div>
              )}
              {sum.unidos_inactivos_en_siigo > 0 && <div className="text-warn-ink">⚠ {sum.unidos_inactivos_en_siigo} productos de WooCommerce están inactivos en Siigo (al facturarlos Siigo los rechazará).</div>}
              {sum.ambiguos_detalle.length > 0 && (
                <details className="text-warn-ink"><summary className="cursor-pointer">Ver los {sum.ambiguos} ambiguos</summary><ul className="list-disc pl-5 text-[13px]">{sum.ambiguos_detalle.map((a) => <li key={a}>{a}</li>)}</ul></details>
              )}
              {sum.errores_detalle.length > 0 && (
                <details className="text-err-ink"><summary className="cursor-pointer">Ver los errores</summary><ul className="list-disc pl-5 text-[13px]">{sum.errores_detalle.map((a) => <li key={a}>{a}</li>)}</ul></details>
              )}
            </>
          )}
        </div>
      )}

      {st && (
        <p className="text-[12px] text-dim">
          Última completa: {when(st.lastFull?.finished_at ?? null)} · últimas existencias: {when(st.lastStock?.finished_at ?? st.lastFull?.finished_at ?? null)} ·
          Catálogo: {st.counts.woocommerce} solo WooCommerce, {st.counts.siigo} solo Siigo, {st.counts.ambos} en ambos{st.counts.ambiguos ? `, ${st.counts.ambiguos} ambiguos` : ""}.
        </p>
      )}
    </div>
  );
}
