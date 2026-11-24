"use client";

// "Vendiendo desde: …". El cajero ve su bodega (fija: no puede cambiarla; el servidor lo impide aunque se manipule la pantalla).
// El admin puede cambiarla SOLO para su sesión de caja con un selector; queda en el log quién cambió y a cuál.
import { useEffect, useState } from "react";
import type { CatalogWarehouse } from "@/lib/client/catalog";

type Wh = { id: number; name: string };

export default function WarehouseSwitcher({
  isAdmin,
  current,
  locked,
  onChanged,
}: {
  isAdmin: boolean;
  current: CatalogWarehouse;
  /** hay productos en el carrito: no se cambia de bodega a mitad de una venta */
  locked: boolean;
  onChanged: () => void;
}) {
  const [list, setList] = useState<Wh[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    fetch("/api/admin/bodegas/sesion", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setList(d.warehouses ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return current ? (
      <div className="text-[13px] text-dim" data-testid="warehouse-label">
        Vendiendo desde: <b className="text-body">{current.name}</b>
      </div>
    ) : null;
  }

  async function change(value: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/bodegas/sesion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouse_id: value === "" ? null : Number(value) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar la bodega");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="warehouse-switcher">
      <label htmlFor="wh-session" className="text-[13px] text-dim">
        Vendiendo desde:
      </label>
      <select
        id="wh-session"
        value={current?.id ?? ""}
        disabled={busy || locked}
        title={locked ? "Termine o vacíe el carrito para cambiar de bodega" : "Bodega de Siigo para esta sesión"}
        onChange={(e) => void change(e.target.value)}
        className="min-h-11 rounded-lg border border-field bg-surface text-fg text-[14px] px-3 max-w-full disabled:opacity-60"
      >
        {!current && <option value="">(sin bodega)</option>}
        {list.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        {current && !list.some((w) => w.id === current.id) && <option value={current.id}>{current.name}</option>}
      </select>
      {locked && <span className="text-[12px] text-dim">(vacíe el carrito para cambiarla)</span>}
      {error && <span className="text-[12px] text-err-ink">{error}</span>}
    </div>
  );
}
