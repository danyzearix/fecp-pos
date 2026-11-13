import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { writeLog } from "@/lib/log";
import {
  canAccessReceipt, downloadName, getReceipt, loadReceiptSale, readReceiptFile, ReceiptError, RECEIPT_MAX_BYTES, saveReceipt,
} from "@/lib/receipts";
import { isUuid } from "@/lib/sales";

export const maxDuration = 60;

// Encabezados de seguridad para la imagen: nunca en caché compartida, y el navegador no "adivina" el tipo.
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const err = (status: number, error: string) => NextResponse.json({ error }, { status, headers: PRIVATE });

/**
 * GET /api/sales/<id>/comprobante            → la imagen (para el visor)
 * GET /api/sales/<id>/comprobante?descargar=1 → la imagen como descarga: comprobante-C01-000123-2026-11-12.jpg
 * Admin: todos. Cajero: solo sus ventas de hoy o ayer. Cliente: nunca (no tiene permiso a /api/sales). Cada acceso queda en logs.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return err(400, "id inválido");

  const sale = await loadReceiptSale(id);
  if (!sale) return err(404, "Venta no encontrada");
  if (!canAccessReceipt(g.user, sale)) return err(403, "Solo puedes ver los comprobantes de tus ventas de hoy o ayer");

  const r = await getReceipt(id);
  if (!r || r.status === "pendiente") return err(404, "Esta venta no tiene comprobante");
  if (r.status === "eliminado") return err(410, `Eliminado por retención el ${r.deleted_at?.toISOString().slice(0, 10) ?? "—"}`);

  let data: Buffer;
  try {
    data = await readReceiptFile(r);
  } catch (e) {
    return err(e instanceof ReceiptError ? e.status : 500, e instanceof Error ? e.message : "Error");
  }
  const download = new URL(req.url).searchParams.get("descargar") === "1";
  const name = downloadName(sale.local_number, sale.sale_day);
  await writeLog("venta", `Comprobante de ${sale.local_number} ${download ? "DESCARGADO" : "visto"} por ${g.user.name}`, {
    userId: g.user.uid,
    detail: { sale_id: id, download },
  });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      ...PRIVATE,
      "Content-Type": "image/jpeg",
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    },
  });
}

/**
 * POST /api/sales/<id>/comprobante  (multipart, campo "file"). Adjunta el comprobante de una venta.
 * Mismas reglas de acceso que el GET. Una imagen por venta: reemplazarla solo lo puede hacer un admin.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return err(400, "id inválido");

  // Corta antes de leer el cuerpo si es claramente demasiado grande (10 MB de imagen + margen del formulario)
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > RECEIPT_MAX_BYTES + 512 * 1024) return err(413, "La imagen pesa más de 10 MB.");

  const sale = await loadReceiptSale(id);
  if (!sale) return err(404, "Venta no encontrada"); // la cola sin conexión reintenta cuando la venta ya exista
  if (!canAccessReceipt(g.user, sale)) return err(403, "Solo puedes adjuntar comprobantes a tus ventas de hoy o ayer");

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return err(400, "No se recibió la imagen");
  }
  if (!file || file.size === 0) return err(400, "No se recibió la imagen");
  if (file.size > RECEIPT_MAX_BYTES) return err(413, "La imagen pesa más de 10 MB.");

  try {
    const r = await saveReceipt({ sale, input: new Uint8Array(await file.arrayBuffer()), user: g.user });
    return NextResponse.json({ ok: true, ...r }, { headers: PRIVATE });
  } catch (e) {
    if (e instanceof ReceiptError) return err(e.status, e.message);
    await writeLog("error", `Error guardando el comprobante de ${sale.local_number}: ${e instanceof Error ? e.message : e}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    return err(500, "No se pudo guardar el comprobante. Intente de nuevo.");
  }
}
