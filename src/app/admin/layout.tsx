import Link from "next/link";
import LogoutButton from "@/components/LogoutButton";
import FullscreenButton from "@/components/FullscreenButton";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { requirePage } from "@/lib/auth";

const LINKS = [
  { href: "/admin/productos", label: "Productos" },
  { href: "/admin/clientes", label: "Clientes" },
  { href: "/admin/usuarios", label: "Usuarios" },
  { href: "/admin/reportes", label: "Reportes" },
  { href: "/admin/pagos-por-revisar", label: "Pagos por revisar" },
  { href: "/admin/logs", label: "Logs" },
  { href: "/admin/configuracion", label: "Configuración" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePage("/admin"); // sin sesión → login; sin permiso → su pantalla de inicio
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
