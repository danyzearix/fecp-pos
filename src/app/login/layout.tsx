import type { Metadata } from "next";

// La página de login es de cliente (no puede exportar metadata): el título va aquí.
export const metadata: Metadata = { title: "Iniciar sesión" };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
