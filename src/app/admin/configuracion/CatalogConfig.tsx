"use client";

// Configuración del catálogo de Siigo y las bodegas: bodega por defecto, cada cuántos minutos se actualizan las existencias,
// lista de precios de Siigo, tipos de producto vendibles y, por bodega, si su catálogo incluye también los de WooCommerce.
import { useCallback, useEffect, useState } from "react";

type Wh = { id: number; name: string; active: boolean; include_woo: boolean };
type Cfg = { default_warehouse_id: number | null; stock_sync_minutes: number; price_list: string; include_types: string[]; all_types: string[] };

const TYPE_LABEL: Record<string, string> = { Product: "Productos", Service: "Servicios", ConsumerGood: "Bienes de consumo", FixedAsset: "Activos fijos" };
const input = "border border-field rounded-lg px-3 min-h-11 text-[14px] text-fg bg-surface";

export default function CatalogConfig() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [whs, setWhs] = useState<Wh[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const [list, setList] = useState("");

  const load = useCallback(async (refresh = false) => {
    const [c, w] = await Promise.all([fetch("/api/admin/catalogo", { cache: "no-store" }), fetch(`/api/admin/bodegas${refresh ? "?refresh=1" : ""}`, { cache: "no-store" })]);
    if (c.ok) {
      const d = (await c.json()) as Cfg;
      setCfg(d);
      setMinutes(String(d.stock_sync_minutes));
      setList(d.price_list);
    }
    if (w.ok) {
      const d = await w.json();
      setWhs(d.warehouses ?? []);
      setStale(!!d.stale);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save(body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/catalogo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      setMsg({ text: res.ok ? ok : d.error ?? `Error ${res.status}`, ok: res.ok });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleWoo(w: Wh) {
    const res = await fetch("/api/admin/bodegas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id, include_woo: !w.include_woo }) });
    if (res.ok) await load();
  }

  if (!cfg) return <p className="text-[13px] text-dim">Cargando…</p>;
  return (
    <div className="space-y-4" data-testid="catalog-config">
      {msg && <div className={`text-[14px] rounded-lg px-3 py-2 ${msg.ok ? "bg-ok-soft text-ok-ink" : "bg-err-soft text-err-ink"}`}>{msg.text}</div>}
      {stale && <div className="text-[13px] text-warn-ink">⚠ Siigo no respondió: se muestra la última lista de bodegas guardada.</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-[13px] font-semibold text-body">Bodega por defecto (usuarios sin bodega asignada)</span>
          <select
            className={`${input} w-full`}
            value={cfg.default_warehouse_id ?? ""}
            disabled={busy}
            onChange={(e) => void save({ default_warehouse_id: e.target.value === "" ? null : Number(e.target.value) }, "Bodega por defecto guardada")}
          >
            <option value="">(ninguna: no se manda bodega a Siigo)</option>
            {whs.filter((w) => w.active).map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>

        <div className="space-y-1">
          <span className="text-[13px] font-semibold text-body">Actualizar existencias cada (minutos, 0 = apagado)</span>
          <div className="flex gap-2">
            <input className={`${input} w-28`} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Minutos entre actualizaciones de existencias" />
            <button disabled={busy} onClick={() => void save({ stock_sync_minutes: Number(minutes) }, "Frecuencia de existencias guardada")} className="px-4 min-h-11 rounded-lg border border-brand text-brand-text text-[14px] font-medium disabled:opacity-60">Guardar</button>
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-[13px] font-semibold text-body">Lista de precios de Siigo para los productos que solo están en Siigo</span>
          <div className="flex gap-2">
            <input className={`${input} flex-1 min-w-0`} value={list} onChange={(e) => setList(e.target.value)} aria-label="Nombre de la lista de precios de Siigo" />
            <button disabled={busy} onClick={() => void save({ price_list: list }, "Lista de precios guardada (vale desde la próxima sincronización)")} className="px-4 min-h-11 rounded-lg border border-brand text-brand-text text-[14px] font-medium disabled:opacity-60">Guardar</button>
          </div>
          <p className="text-[12px] text-dim">Debe llamarse igual que en Siigo (p. ej. «Precio de venta 2»). Si un producto no la tiene se usa «Precio de venta 1».</p>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-[13px] font-semibold text-body">Tipos de producto de Siigo que se pueden vender</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {cfg.all_types.map((t) => (
              <label key={t} className="flex items-center gap-2 min-h-11 text-[14px] text-fg">
                <input
                  type="checkbox"
                  className="w-5 h-5"
                  checked={cfg.include_types.includes(t)}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.checked ? [...cfg.include_types, t] : cfg.include_types.filter((x) => x !== t);
                    void save({ include_types: next }, "Tipos de producto guardados (valen desde la próxima sincronización)");
                  }}
                />
                {TYPE_LABEL[t] ?? t}
              </label>
            ))}
          </div>
          <p className="text-[12px] text-dim">Los inactivos en Siigo nunca se venden. Los servicios no se incluyen por defecto.</p>
        </fieldset>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-[14px] font-semibold text-fg">Bodegas activas: ¿su catálogo incluye los productos de WooCommerce?</h3>
          <button onClick={() => void load(true)} className="px-3 min-h-11 rounded-lg border border-field bg-surface text-[13px] text-body">Actualizar bodegas</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[14px] text-fg">
            <tbody className="divide-y divide-line">
              {whs.filter((w) => w.active).map((w) => (
                <tr key={w.id}>
                  <td className="py-1 pr-4">{w.name}</td>
                  <td className="py-1">
                    <label className="flex items-center gap-2 min-h-11">
                      <input type="checkbox" className="w-5 h-5" checked={w.include_woo} onChange={() => void toggleWoo(w)} aria-label={`Incluir los productos de WooCommerce en ${w.name}`} />
                      <span className="text-[13px] text-dim">{w.include_woo ? "Sí (productos de la bodega + WooCommerce)" : "No: solo los productos de esta bodega"}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
