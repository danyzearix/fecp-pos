"use client";

import { useState } from "react";

/** Diálogo para salir del kiosco: pide correo y contraseña de un ADMINISTRADOR (límite de intentos y logs en el servidor). */
export default function ExitDialog({ onCancel }: { onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/kiosco/salir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error ?? "No se pudo salir");
        setPassword("");
        setBusy(false);
        return;
      }
      window.location.href = "/login";
    } catch {
      setError("Sin conexión con el servidor");
      setBusy(false);
    }
  }

  const input =
    "mt-1 w-full border border-field rounded-lg px-4 py-3 text-lg text-fg placeholder:text-lg placeholder:text-faint outline-none focus:border-brand";
  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-surface rounded-2xl shadow-2xl w-full max-w-md p-8 space-y-4">
        <h2 className="text-xl font-bold text-fg">Salir del autoservicio</h2>
        <p className="text-[14px] text-soft">Solo un administrador puede cerrar el kiosco.</p>
        <label className="block text-[15px] font-semibold text-body">
          Correo del administrador
          <input className={input} type="email" autoFocus autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@ejemplo.com" required />
        </label>
        <label className="block text-[15px] font-semibold text-body">
          Contraseña
          <input className={input} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Contraseña" required />
        </label>
        {error && <p className="text-[15px] text-err-ink bg-err-soft rounded-lg p-3">{error}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="flex-1 py-3 rounded-lg border border-field text-lg font-medium text-body">
            Cancelar
          </button>
          <button disabled={busy} className="flex-1 py-3 rounded-lg bg-brand text-white text-lg font-semibold disabled:opacity-60">
            {busy ? "Verificando…" : "Salir"}
          </button>
        </div>
      </form>
    </div>
  );
}
