"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunRow, SyncStatus } from "@/lib/siigo/customer-sync";

const fmt = (d: string | Date | null) =>
  d ? new Date(d).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" }) : "—";
const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("es-CO");
const COLS: Record<string, string> = {
  siigo_id: "id de Siigo", id_type: "tipo de documento", check_digit: "dígito de verificación", first_name: "nombres", last_name: "apellidos",
  company_name: "razón social", email: "correo", phone: "teléfono", address: "dirección", state_code: "departamento", city_code: "ciudad", active: "estado activo",
};
const REASONS: Record<string, string> = {
  sin_tipo_documento: "sin tipo de documento",
  sin_nombre: "sin nombre",
  identificacion_invalida: "documento con formato no válido",
  consumidor_final: "Consumidor final (no se toca)",
  duplicada: "identificación repetida en Siigo",
  sin_id_siigo: "sin id de Siigo",
  error_base_de_datos: "error al guardar",
};

function progress(r: RunRow) {
  const pages = r.total_pages ?? 0;
  if (!pages) return { pct: 0, label: "Conectando con Siigo…" };
  const done = Math.min(r.status === "done" ? pages : r.next_page - 1, pages);
  const phase = r.mode === "incremental" ? (r.phase === "updated" ? " · modificados" : " · nuevos") : "";
  return { pct: Math.round((done / pages) * 100), label: `Página ${Math.min(done + (r.status === "running" ? 1 : 0), pages)} de ${pages}${phase}` };
}

export default function SyncPanel({ initial }: { initial: SyncStatus }) {
  const [st, setSt] = useState<SyncStatus>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/clientes/sync", { cache: "no-store" });
      if (r.ok) setSt((await r.json()) as SyncStatus);
    } catch {
      /* sin conexión: se reintenta */
    }
  }, []);

  const running = st.run?.status === "running" && !st.interrupted;
  useEffect(() => {
    if (!running) return;
    timer.current = setTimeout(function tick() {
      void refresh();
      timer.current = setTimeout(tick, 2000);
    }, 2000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [running, refresh]);

  async function start(full: boolean) {
    setBusy(true);
    setMsg(null);
    setConfirmFull(false);
    try {
      const r = await fetch("/api/admin/clientes/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string; resumed?: boolean; mode?: string };
      if (!r.ok) setMsg({ ok: false, text: j.error ?? "No se pudo iniciar la sincronización" });
      else setMsg({ ok: true, text: j.resumed ? "Retomando desde donde quedó…" : j.mode === "full" ? "Sincronización completa iniciada." : "Sincronización incremental iniciada." });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const run = st.run;
  const last = st.lastDone;
  const p = run && (run.status === "running" || st.interrupted) ? progress(run) : null;
  const lastErr = run && run.status !== "done" && run.error_message ? run.error_message : null;
  const skipLine = (r: RunRow) =>
    Object.entries(r.skip_reasons ?? {})
      .map(([k, v]) => `${v} ${REASONS[k] ?? k}`)
      .join(" · ");
  const changeLine = (r: RunRow) => {
    const e = Object.entries(r.changes ?? {});
    return e.length ? "cambiaron: " + e.map(([k, v]) => `${COLS[k] ?? k} ${v}`).join(", ") : "";
  };

  return (
    <section className="bg-surface rounded-xl border border-line p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-[13px] text-dim">Clientes en el POS</div>
          <div className="text-[22px] font-bold text-fg leading-tight">{n(st.totals.inPos)}</div>
          <div className="text-[12px] text-dim">
            {n(st.totals.fromSiigo)} de Siigo{st.totals.inactive ? ` · ${n(st.totals.inactive)} inactivos` : ""}
          </div>
        </div>
        <div>
          <div className="text-[13px] text-dim">Última sincronización</div>
          <div className="text-[15px] font-semibold text-fg">{last ? fmt(last.finished_at) : "Nunca"}</div>
          {last && (
            <div className="text-[12px] text-dim">
              {last.mode === "full" ? "Completa" : "Incremental"} · {n(last.created)} nuevos · {n(last.updated)} actualizados
            </div>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {st.interrupted && (
            <button onClick={() => start(false)} disabled={busy} className="px-4 min-h-11 rounded-lg bg-warn-soft text-warn-ink border border-warn-line text-[14px] font-semibold disabled:opacity-50">
              Retomar sincronización
            </button>
          )}
          <button
            onClick={() => start(false)}
            disabled={busy || running || st.interrupted}
            className="px-4 min-h-11 rounded-lg bg-brand text-white text-[14px] font-semibold disabled:opacity-50"
          >
            {running ? "Sincronizando…" : "Sincronizar clientes"}
          </button>
          {!running && !confirmFull && (
            <button onClick={() => setConfirmFull(true)} disabled={busy} className="px-3 min-h-11 text-[13px] text-brand-text underline disabled:opacity-50">
              Recarga completa
            </button>
          )}
        </div>
      </div>

      {confirmFull && (
        <div className="rounded-lg border border-warn-line bg-warn-soft p-3 text-[14px] text-warn-ink flex flex-wrap items-center gap-3">
          <span>Vuelve a pedir TODOS los clientes a Siigo (unos 5 minutos). Úsala solo si algo no cuadra; lo normal es «Sincronizar clientes».</span>
          <button onClick={() => start(true)} disabled={busy} className="px-4 min-h-11 rounded-lg bg-brand text-white font-semibold">Sí, recarga completa</button>
          <button onClick={() => setConfirmFull(false)} className="px-3 min-h-11 underline">Cancelar</button>
        </div>
      )}

      {p && run && (
        <div className="space-y-1.5" role="status" aria-live="polite">
          <div className="flex justify-between text-[13px] text-body">
            <span>{st.interrupted ? "Interrumpida: se puede retomar" : p.label}</span>
            <span className="font-semibold">{p.pct}%</span>
          </div>
          <div className="h-3 rounded-full bg-subtle overflow-hidden border border-line" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full ${st.interrupted ? "bg-warn-ink" : "bg-brand"} transition-all`} style={{ width: `${p.pct}%` }} />
          </div>
          <div className="text-[12px] text-dim">
            {n(run.created)} nuevos · {n(run.updated)} actualizados · {n(run.unchanged)} sin cambios · {n(run.skipped)} omitidos · {n(run.errors)} errores
          </div>
        </div>
      )}

      {msg && <div className={`text-[14px] ${msg.ok ? "text-ok-ink" : "text-err-ink"}`}>{msg.text}</div>}
      {lastErr && <div className="text-[14px] text-err-ink">Último error: {lastErr}</div>}

      {st.recent.length > 0 && (
        <details className="text-[13px] text-body">
          <summary className="cursor-pointer min-h-11 flex items-center text-brand-text">Historial de sincronizaciones</summary>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] text-fg mt-1">
              <thead className="bg-subtle text-left text-body">
                <tr>
                  <th className="px-3 py-1.5">Inicio</th>
                  <th className="px-3 py-1.5">Tipo</th>
                  <th className="px-3 py-1.5">Estado</th>
                  <th className="px-3 py-1.5 text-right">Nuevos</th>
                  <th className="px-3 py-1.5 text-right">Actualizados</th>
                  <th className="px-3 py-1.5 text-right">Omitidos</th>
                  <th className="px-3 py-1.5 text-right">Errores</th>
                  <th className="px-3 py-1.5">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {st.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{fmt(r.started_at)}</td>
                    <td className="px-3 py-1.5">{r.mode === "full" ? "Completa" : "Incremental"}</td>
                    <td className="px-3 py-1.5">
                      {r.status === "done" ? "Terminada" : r.status === "cancelled" ? "Descartada" : r.status === "interrupted" || r.stale ? "Interrumpida" : "En curso"}
                    </td>
                    <td className="px-3 py-1.5 text-right">{n(r.created)}</td>
                    <td className="px-3 py-1.5 text-right">{n(r.updated)}</td>
                    <td className="px-3 py-1.5 text-right">{n(r.skipped + r.duplicates)}</td>
                    <td className="px-3 py-1.5 text-right">{n(r.errors)}</td>
                    <td className="px-3 py-1.5 text-dim">{[skipLine(r), changeLine(r), r.error_message].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
