"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Result = {
  created: number;
  updated: number;
  deactivated: number;
  total: number;
  noSku: number;
  pricesIncludeTax: boolean;
  unknownTaxClasses: string[];
  siigo: { checked: number; changed: number; notFound: number; ivaDiferente: number } | null;
};

export default function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/sync/products", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setResult(data);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={run}
        disabled={busy}
        className="bg-brand text-white text-base font-semibold rounded-lg px-5 min-h-11 disabled:opacity-60"
      >
        {busy ? "Sincronizando… (puede tardar)" : "Sincronizar productos"}
      </button>
      {error && <p className="text-base text-err-ink bg-err-soft rounded-lg p-3">{error}</p>}
      {result && (
        <div className="text-base bg-ok-soft text-ok-ink rounded-lg p-3 space-y-1">
          <div>
            Listo: {result.total} productos. <b>{result.created}</b> creados, <b>{result.updated}</b> actualizados,{" "}
            <b>{result.deactivated}</b> desactivados.
          </div>
          <div>Precios de la tienda {result.pricesIncludeTax ? "INCLUYEN" : "NO incluyen"} IVA.</div>
          {result.siigo ? (
            <div>
              IVA según Siigo: {result.siigo.checked} verificados, {result.siigo.changed} actualizados
              {result.siigo.notFound > 0 && <span className="text-warn-ink">, ⚠ {result.siigo.notFound} no existen en Siigo</span>}.
              {result.siigo.ivaDiferente > 0 && (
                <span className="text-warn-ink">
                  {" "}⚠ {result.siigo.ivaDiferente} con IVA distinto en la tienda (se usa el de Siigo). Lista: npm run report:iva
                </span>
              )}
            </div>
          ) : (
            <div className="text-warn-ink">⚠ No se pudo consultar el IVA en Siigo (ver logs). Se usó el IVA de Woo.</div>
          )}
          {result.noSku > 0 && <div className="text-warn-ink">⚠ {result.noSku} productos sin SKU (no se pueden facturar).</div>}
          {result.unknownTaxClasses.length > 0 && (
            <div className="text-warn-ink">
              ⚠ Clases de impuesto desconocidas (se usó 19%): {result.unknownTaxClasses.map((c) => `"${c}"`).join(", ")}. Edita
              src/config/tax-map.ts.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
