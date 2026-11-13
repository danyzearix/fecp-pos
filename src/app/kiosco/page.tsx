import KioscoClient from "@/components/kiosco/KioscoClient";
import { requirePage } from "@/lib/auth";
import { getPosConfig } from "@/lib/config";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Kiosco" };

// Autoservicio: solo el rol 'cliente' (permissions.ts). Sin barra lateral ni enlaces a otras rutas.
export default async function KioscoPage() {
  await requirePage("/kiosco");
  const pos = getPosConfig();
  return (
    <KioscoClient
      uvt={pos.uvt}
      printer={process.env.KIOSCO_IMPRESORA === "true"}
      defaultState={pos.defaultStateCode}
      defaultCity={pos.defaultCityCode}
    />
  );
}
