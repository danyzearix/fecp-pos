"use client";

import { useState } from "react";

type Check = { name: string; ok: boolean; detail: string };

function Test({ service, title }: { service: "woo" | "siigo"; title: string }) {
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    setChecks(null);
    try {
      const res = await fetch(`/api/admin/test/${service}`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error ?? `Error ${res.status}`);
      else setChecks(d.checks);
    } catch {
      setError("Sin conexión con el servidor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button onClick={run} disabled={busy} className="bg-brand text-white font-semibold rounded-lg px-4 min-h-11 text-[14px] disabled:opacity-60">
        {busy ? "Probando…" : title}
      </button>
      {error && <p className="text-[13px] text-err-ink">{error}</p>}
      {checks && (
        <ul className="text-[13px] space-y-1">
          {checks.map((c) => (
            <li key={c.name} className={c.ok ? "text-ok-ink" : "text-err-ink"}>
              {c.ok ? "✓" : "✗"} <b>{c.name}</b>: {c.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ConnectionTests() {
  return (
    <div className="flex gap-10 flex-wrap">
      <Test service="woo" title="Probar conexión WooCommerce" />
      <Test service="siigo" title="Probar conexión Siigo" />
    </div>
  );
}
