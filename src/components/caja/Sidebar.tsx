"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import FullscreenButton from "@/components/FullscreenButton";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { canOpenPage, type Role } from "@/lib/permissions";
import { IconBars, IconBox, IconCart, IconClock, IconLogout } from "./Icons";

type Props = {
  userName: string;
  role: Role;
  online: boolean;
  pending: number;
  active?: "caja" | "ventas";
  catalogUpdatedAt?: number | null;
};

function ago(ts: number, now: number) {
  const min = Math.floor(Math.max(0, now - ts) / 60_000);
  if (min < 1) return "hace menos de 1 min";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
}

/** Estado de conexión y ventas por enviar. Visible SIEMPRE, también con el menú cerrado en celular. */
function ConnectionChip({ online, pending, compact = false }: { online: boolean; pending: number; compact?: boolean }) {
  return (
    <div
      className={`rounded-md font-semibold leading-tight ${compact ? "px-2 py-1 text-[12px] whitespace-nowrap" : "px-1 py-1.5 text-[11px] text-center"} ${
        online ? "bg-ok-soft text-ok-ink" : "bg-err-soft text-err-ink"
      }`}
    >
      <span className={`inline-block w-2 h-2 rounded-full mr-1 ${online ? "bg-ok-dot" : "bg-err-dot"}`} />
      {online ? "En línea" : "Sin conexión"}
      {pending > 0 &&
        (compact ? (
          <span> · {pending}</span>
        ) : (
          <div className="mt-0.5">
            {pending} pendiente{pending > 1 ? "s" : ""}
          </div>
        ))}
    </div>
  );
}

export default function Sidebar({ userName, role, online, pending, active = "caja", catalogUpdatedAt = null }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000); // refresca el "hace X min"
    return () => clearInterval(iv);
  }, []);

  const initials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  // Objetivo táctil de 44 px de alto como mínimo en cada opción
  const item = (on: boolean) =>
    `flex flex-col items-center justify-center gap-1 py-3 min-h-11 text-xs font-medium w-full ${
      on ? "text-brand-text bg-brand-soft border-l-4 border-brand" : "text-soft hover:bg-hover border-l-4 border-transparent"
    }`;
  const rowItem = (on: boolean) =>
    `flex items-center gap-3 px-4 py-3 min-h-11 text-[15px] font-medium w-full ${
      on ? "text-brand-text bg-brand-soft border-l-4 border-brand" : "text-body hover:bg-hover border-l-4 border-transparent"
    }`;

  const isAdmin = canOpenPage(role, "/admin");

  const links = (cls: (on: boolean) => string, onNavigate?: () => void) => (
    <>
      <Link href="/caja" className={cls(active === "caja")} onClick={onNavigate}>
        <IconCart /> Ventas
      </Link>
      <Link href="/ventas" className={cls(active === "ventas")} onClick={onNavigate}>
        <IconClock /> Historial
      </Link>
      {isAdmin && (
        <>
          <Link href="/admin/productos" className={cls(false)} onClick={onNavigate}>
            <IconBox /> Productos
          </Link>
          <Link href="/admin/reportes" className={cls(false)} onClick={onNavigate}>
            <IconBars /> Reportes
          </Link>
        </>
      )}
      <button onClick={logout} className={cls(false)}>
        <IconLogout /> Salir
      </button>
    </>
  );

  return (
    <>
      {/* ---------- Celular: barra superior con hamburguesa. La conexión queda siempre a la vista ---------- */}
      <header className="md:hidden shrink-0 flex items-center gap-3 px-3 py-2 bg-surface border-b border-line">
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Abrir menú"
          aria-expanded={menuOpen}
          className="w-11 h-11 shrink-0 rounded-lg flex items-center justify-center text-body hover:bg-hover"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <Logo className="h-8 w-14 shrink-0" />
        <div className="ml-auto flex items-center gap-2">
          <ConnectionChip online={online} pending={pending} compact />
          <div title={userName} className="w-9 h-9 shrink-0 rounded-full bg-brand text-white flex items-center justify-center text-[13px] font-bold">
            {initials || "?"}
          </div>
        </div>
      </header>

      {/* Menú deslizable del celular */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
          <nav className="relative w-72 max-w-[85vw] h-full bg-surface border-r border-line flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <Logo className="h-9 w-16" />
              <button onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" className="w-11 h-11 rounded-lg text-dim hover:bg-hover text-2xl leading-none">
                ×
              </button>
            </div>
            <div className="flex-1 flex flex-col py-1">{links(rowItem, () => setMenuOpen(false))}</div>
            <div className="p-3 space-y-2 border-t border-line">
              <ConnectionChip online={online} pending={pending} />
              {catalogUpdatedAt && <div className="text-[12px] text-dim">Catálogo actualizado: {ago(catalogUpdatedAt, now)}</div>}
              <div className="flex gap-2">
                <ThemeToggle variant="inline" className="flex-1 justify-center" />
                <FullscreenButton variant="icon" />
              </div>
              <div className="text-[13px] text-dim">{userName}</div>
            </div>
          </nav>
        </div>
      )}

      {/* ---------- Tablet y PC: columna de íconos (más angosta en tablet) ---------- */}
      <aside className="hidden md:flex w-16 lg:w-[88px] shrink-0 bg-surface border-r border-line flex-col overflow-y-auto">
        <div className="py-3 flex justify-center">
          <Logo className="h-9 w-12 lg:h-10 lg:w-16" />
        </div>
        <nav className="flex-1 flex flex-col">
          {links(item)}
          <div className="mt-auto">
            <FullscreenButton variant="sidebar" />
            <ThemeToggle variant="sidebar" />
          </div>
        </nav>

        <div className="p-2 space-y-2 text-center">
          <ConnectionChip online={online} pending={pending} />
          {catalogUpdatedAt && <div className="text-[10px] leading-tight text-dim hidden lg:block">Catálogo actualizado: {ago(catalogUpdatedAt, now)}</div>}
          <div title={userName} className="mx-auto w-10 h-10 rounded-full bg-brand text-white flex items-center justify-center font-bold">
            {initials || "?"}
          </div>
        </div>
      </aside>
    </>
  );
}
