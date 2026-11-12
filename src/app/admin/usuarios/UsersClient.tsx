"use client";

import { useCallback, useEffect, useState } from "react";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/permissions";

type U = {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  siigo_seller_id: number | null;
  locked_until: string | null;
};

const input =
  "w-full border border-field rounded-lg px-3 min-h-11 text-[14px] text-fg placeholder:text-[14px] placeholder:text-faint outline-none focus:border-brand bg-surface";
const label = "block text-[13px] font-semibold text-body";

export default function UsersClient() {
  const [users, setUsers] = useState<U[]>([]);
  const [me, setMe] = useState(0);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "cajero" as Role, seller: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/users", { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      setUsers(d.users);
      setMe(d.me);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function call(url: string, method: string, body: unknown, ok: string) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setMsg({ text: res.ok ? ok : d.error ?? `Error ${res.status}`, ok: res.ok });
    if (res.ok) await load();
    return res.ok;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await call(
      "/api/admin/users",
      "POST",
      { name: form.name, email: form.email, password: form.password, role: form.role, siigo_seller_id: form.seller },
      `Usuario ${form.email} creado`
    );
    if (ok) setForm({ name: "", email: "", password: "", role: "cajero", seller: "" });
    setBusy(false);
  }

  const patch = (u: U, body: unknown, ok: string) => call(`/api/admin/users/${u.id}`, "PATCH", body, ok);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-fg">Usuarios</h1>
        <p className="text-[13px] text-dim">
          El vendedor de Siigo se usa al facturar las ventas de ese usuario. Si está vacío se usa SIIGO_SELLER_ID del .env.
        </p>
      </div>

      {msg && (
        <div className={`text-[14px] rounded-lg px-4 py-2 ${msg.ok ? "bg-ok-soft text-ok-ink" : "bg-err-soft text-err-ink"}`}>{msg.text}</div>
      )}

      <form onSubmit={create} className="bg-surface rounded-xl border border-line p-4 grid grid-cols-2 sm:grid-cols-6 gap-3 items-end">
        <h2 className="col-span-2 sm:col-span-6 font-semibold text-fg">Crear usuario</h2>
        <label className="col-span-2">
          <span className={label}>Nombre</span>
          <input className={input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre completo" />
        </label>
        <label className="col-span-2">
          <span className={label}>Correo</span>
          <input className={input} required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="correo@ejemplo.com" />
        </label>
        <label className="col-span-2">
          <span className={label}>Contraseña (mín. 8)</span>
          <input className={input} required minLength={8} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Contraseña inicial" autoComplete="off" />
        </label>
        <label className="col-span-2">
          <span className={label}>Rol</span>
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        <label className="col-span-2">
          <span className={label}>Vendedor en Siigo (opcional)</span>
          <input className={input} inputMode="numeric" value={form.seller} onChange={(e) => setForm({ ...form, seller: e.target.value })} placeholder="Ej. 744" />
        </label>
        <button disabled={busy} className="col-span-2 bg-brand text-white font-semibold rounded-lg py-2.5 disabled:opacity-60">
          {busy ? "Creando…" : "Crear usuario"}
        </button>
      </form>

      <div className="bg-surface rounded-xl border border-line overflow-x-auto">
        {/* min-w: esta tabla lleva controles (select, campos, botones). En pantallas angostas se desplaza
            de lado DENTRO de la tarjeta en vez de aplastar los controles hasta que no se puedan tocar. */}
        <table className="w-full min-w-[760px] text-[14px] text-fg">
          <thead className="bg-subtle text-left text-[13px] text-body">
            <tr>
              <th className="px-4 py-2">Usuario</th>
              <th className="px-4 py-2">Rol</th>
              <th className="px-4 py-2">Vendedor Siigo</th>
              <th className="px-4 py-2">Estado</th>
              <th className="px-4 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => (
              <UserRow key={u.id} u={u} isMe={u.id === me} patch={patch} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRow({ u, isMe, patch }: { u: U; isMe: boolean; patch: (u: U, body: unknown, ok: string) => Promise<boolean> }) {
  const [seller, setSeller] = useState(u.siigo_seller_id?.toString() ?? "");
  const [pwd, setPwd] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const locked = u.locked_until && new Date(u.locked_until) > new Date();

  return (
    <tr className={u.active ? "" : "bg-subtle text-dim"}>
      <td className="px-4 py-2">
        <div className="font-medium">{u.name}{isMe && <span className="ml-2 text-[11px] bg-brand-soft text-brand-ink rounded px-1.5">tú</span>}</div>
        <div className="text-[12px] text-dim">{u.email}</div>
      </td>
      <td className="px-4 py-2">
        <select
          disabled={isMe}
          value={u.role}
          onChange={(e) => patch(u, { role: e.target.value }, `Rol de ${u.email} actualizado`)}
          className="min-w-28 border border-field rounded-lg px-2 min-h-11 text-[14px] bg-surface text-fg disabled:bg-subtle"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <input
            value={seller}
            onChange={(e) => setSeller(e.target.value)}
            inputMode="numeric"
            placeholder="(del .env)"
            className="w-24 border border-field rounded-lg px-2 min-h-11 text-[14px] text-fg placeholder:text-[13px] bg-surface"
          />
          {seller !== (u.siigo_seller_id?.toString() ?? "") && (
            <button onClick={() => patch(u, { siigo_seller_id: seller }, `Vendedor de ${u.email} guardado`)} className="px-2 min-h-11 text-[13px] text-brand-text font-medium">
              Guardar
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-2 whitespace-nowrap">
        {u.active ? <span className="text-ok-ink">Activo</span> : <span>Desactivado</span>}
        {locked && <span className="ml-2 text-[12px] text-err-ink">bloqueado</span>}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          {!isMe && (
            <button
              onClick={() => patch(u, { active: !u.active }, `${u.email} ${u.active ? "desactivado" : "activado"}`)}
              className="px-3 min-h-11 rounded-md border border-field text-[13px] font-medium text-body hover:bg-hover"
            >
              {u.active ? "Desactivar" : "Activar"}
            </button>
          )}
          {showPwd ? (
            <span className="inline-flex items-center gap-2">
              <input
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="Nueva contraseña"
                autoComplete="off"
                className="w-40 border border-field rounded-lg px-2 min-h-11 text-[14px] text-fg placeholder:text-[13px] bg-surface"
              />
              <button
                disabled={pwd.length < 8}
                onClick={async () => {
                  if (await patch(u, { password: pwd }, `Contraseña de ${u.email} restablecida`)) {
                    setPwd("");
                    setShowPwd(false);
                  }
                }}
                className="px-2 min-h-11 text-[13px] text-brand-text font-medium disabled:opacity-40"
              >
                Guardar
              </button>
              <button onClick={() => setShowPwd(false)} className="px-2 min-h-11 text-[13px] text-dim">Cancelar</button>
            </span>
          ) : (
            <button onClick={() => setShowPwd(true)} className="px-3 min-h-11 rounded-md border border-field text-[13px] font-medium text-body hover:bg-hover">
              Restablecer contraseña
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
