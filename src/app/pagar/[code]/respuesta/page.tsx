import type { Metadata } from "next";
import ReturnView from "../ReturnView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Resultado del pago", robots: { index: false, follow: false } };

/**
 * PÚBLICA (sin sesión): URL de respuesta ANTIGUA (los cobros creados antes de /retorno siguen volviendo aquí). Hace lo mismo que /retorno:
 * el servidor toma el ref_payco de la URL, lo guarda en el intento y lo verifica con ePayco.
 */
export default async function RespuestaPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { code } = await params;
  return <ReturnView code={code} searchParams={await searchParams} />;
}
