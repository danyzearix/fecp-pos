"use client";

import { useState } from "react";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { homeFor, isRole } from "@/lib/permissions";

// Inputs y placeholders a 18px (mínimo pedido: 16px). Formulario ancho para pantallas 1366x768.
const INPUT =
  "mt-1.5 w-full border border-field rounded-lg px-4 py-3 text-lg text-fg bg-surface " +
  "placeholder:text-lg placeholder:text-faint outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No se pudo iniciar sesión");
        setBusy(false);
        return;
      }
      const role = data?.user?.role;
      window.location.href = isRole(role) ? homeFor(role) : "/"; // recarga completa para que la cookie aplique
    } catch {
      setError("Sin conexión con el servidor");
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-screen flex items-center justify-center bg-app p-4">
      {/* Botón discreto: el tema queda guardado en este equipo */}
      <ThemeToggle variant="icon" className="absolute top-3 right-3" />
      <form onSubmit={onSubmit} className="w-full max-w-md bg-surface rounded-xl shadow p-10 space-y-5">
        <div className="text-center">
          <h1 className="flex justify-center">
            <Logo className="h-20 w-48" alt="FECP POS" />
          </h1>
          <p className="text-base text-dim mt-1">Inicia sesión para continuar</p>
        </div>
        <label className="block text-base font-medium text-body">
          Correo
          <input
            type="email"
            autoFocus
            required
            autoComplete="username"
            placeholder="correo@ejemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="block text-base font-medium text-body">
          Contraseña
          <input
            type="password"
            required
            autoComplete="current-password"
            placeholder="Tu contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT}
          />
        </label>
        {error && <p className="text-base text-err-ink bg-err-soft rounded-lg p-3">{error}</p>}
        <button
          disabled={busy}
          className="w-full bg-brand text-white text-lg rounded-lg py-3 font-semibold disabled:opacity-60"
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
