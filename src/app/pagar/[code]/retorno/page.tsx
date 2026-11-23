import type { Metadata } from "next";
import ReturnView from "../ReturnView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Resultado del pago", robots: { index: false, follow: false } };

/**
 * PÚBLICA (sin sesión): URL de respuesta que el POS manda a ePayco en CADA intento por QR. ePayco devuelve aquí el celular del cliente
 * (?ref_payco=<referencia larga>). OJO: llegar aquí NO significa que pagó; el servidor lo verifica con ePayco.
 */
export default async function RetornoPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { code } = await params;
  return <ReturnView code={code} searchParams={await searchParams} />;
}
