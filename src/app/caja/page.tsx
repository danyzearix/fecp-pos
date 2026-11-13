import { requirePage } from "@/lib/auth";
import { getPosConfig } from "@/lib/config";
import { epaycoMissingEnv } from "@/lib/epayco/config";
import { epaycoInvoicingBlocker } from "@/lib/siigo/payment";
import CajaClient from "@/components/caja/CajaClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Caja" };

export default async function CajaPage() {
  const user = await requirePage("/caja"); // sin sesión → login; sin permiso (p. ej. rol cliente) → su pantalla de inicio
  // El botón "Pago electrónico (ePayco)" solo se habilita si hay llaves y si luego se podría facturar (mismo criterio del kiosco)
  const epaycoReady = epaycoMissingEnv().length === 0 && !epaycoInvoicingBlocker();
  return <CajaClient user={{ name: user.name, role: user.role }} config={getPosConfig()} epaycoReady={epaycoReady} />;
}
