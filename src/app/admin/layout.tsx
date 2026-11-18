import Link from "next/link";
import LogoutButton from "@/components/LogoutButton";
import FullscreenButton from "@/components/FullscreenButton";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { requirePage } from "@/lib/auth";
import { reviewCounts } from "@/lib/price-review";

const LINKS = [
  { href: "/admin/productos", label: "Productos" },
  { href: "/admin/clientes", label: "Clientes" },
  { href: "/admin/usuarios", label: "Usuarios" },
  { href: "/admin/reportes", label: "Reportes" },
  { href: "/admin/pagos-por-revisar", label: "Pagos por revisar", badge: "payments" as const },
  { href: "/admin/precios-por-revisar", label: "Precios por revisar", badge: "prices" as const },
  { href: "/admin/logs", label: "Logs" },
  { href: "/admin/configuracion", label: "Configuración" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePage("/admin"); // sin sesión → login; sin permiso → su pantalla de inicio
  // Lo que un admin debe resolver: contadores junto a "Pagos por revisar" y "Precios por revisar"
  const counts = await reviewCounts().catch(() => null);
  return (
    // overflow-x-hidden: las tablas anchas hacen scroll DENTRO de su tarjeta, nunca la página entera
    <div className="min-h-screen overflow-x-hidden">
      <header className="bg-surface border-b border-line px-3 sm:px-6 py-2 flex items-center gap-3 sm:gap-6 flex-wrap">
        <Logo className="h-9 w-14 shrink-0" />
        {/* En celular y tablet los enlaces se desplazan de lado; desde lg caben todos */}
        <nav className="order-last w-full lg:order-none lg:w-auto flex gap-1 lg:gap-2 text-[15px] overflow-x-auto lg:overflow-visible lg:flex-wrap">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="whitespace-nowrap px-3 inline-flex items-center justify-center min-w-11 min-h-11 text-body hover:text-brand-text font-medium"
            >
              {l.label}
              {"badge" in l && counts && (l.badge === "payments" ? counts.payments : counts.prices) > 0 && (
                <span
                  className={`ml-1.5 min-w-6 h-6 px-1.5 inline-flex items-center justify-center rounded-full text-[12px] font-bold ${
                    l.badge === "prices"
                      ? counts.pricesLevel === "critica"
                        ? "bg-err text-white"
                        : counts.pricesLevel === "atrasada"
                          ? "bg-warn-soft text-warn-ink border border-warn-line"
                          : "bg-review-soft text-review-ink"
                      : "bg-review-soft text-review-ink"
                  }`}
                  title={
                    l.badge === "prices"
                      ? counts.pricesLevel === "critica" ? "Hay ventas retenidas hace más de 4 horas" : counts.pricesLevel === "atrasada" ? "Hay ventas retenidas hace más de 2 horas" : "Ventas retenidas por precio"
                      : "Pagos electrónicos por revisar"
                  }
                  aria-label={`${l.badge === "prices" ? counts.prices : counts.payments} pendientes`}
                >
                  {l.badge === "prices" ? counts.prices : counts.payments}
                  {l.badge === "prices" && counts.pricesLevel !== "ok" ? "!" : ""}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2 text-[14px]">
          <Link href="/caja" className="inline-flex items-center min-h-11 px-2 text-brand-text font-medium whitespace-nowrap">
            <span className="lg:hidden">← Caja</span>
            <span className="hidden lg:inline">← Volver a caja</span>
          </Link>
          <FullscreenButton variant="icon" />
          <ThemeToggle variant="icon" />
          <span className="hidden xl:inline text-soft">{user.name}</span>
          <LogoutButton />
        </div>
      </header>
      <div className="p-3 sm:p-6 min-w-0">{children}</div>
    </div>
  );
}
