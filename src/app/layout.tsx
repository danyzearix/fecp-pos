import type { Metadata } from "next";
import { THEME_SCRIPT } from "@/lib/client/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "FECP POS",
  description: "Punto de venta FECP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: el script de abajo agrega la clase .dark antes de que React hidrate
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Corre mientras el navegador lee el HTML, antes del primer pintado: evita el parpadeo claro→oscuro */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-app text-fg antialiased">{children}</body>
    </html>
  );
}
