import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { writeLog } from "@/lib/log";
import { createSale, isDateStr, isReceiptFilter, listSales, parseSale, todayBogota, yesterdayBogota } from "@/lib/sales";
import { invoiceSale, sweepStuckInvoicing } from "@/lib/siigo/invoice";

export const maxDuration = 180; // creación de factura hasta 120 s + consulta de estado DIAN

export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const user = g.user;

  const body = await req.json().catch(() => null);
  const sale = parseSale(body);
  if (typeof sale === "string") {
    await writeLog("error", `Venta rechazada por datos inválidos: ${sale}`, { level: "warn", userId: user.uid });
    return NextResponse.json({ error: sale }, { status: 400 });
  }

  try {
    const r = await createSale(sale, user.uid);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

    // Facturar. Si la venta ya está facturada o en proceso (envío repetido), invoiceSale no hace nada.
    const inv = await invoiceSale(r.id, user.uid);
    return NextResponse.json({
      ok: true,
      id: r.id,
      status: inv.status,
      invoice_name: inv.invoice_name,
      invoice_error: inv.error,
      duplicate: r.duplicate,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeLog("error", `Error registrando venta ${sale.local_number}: ${msg}`, {
      level: "error",
      userId: user.uid,
      detail: { id: sale.id, error: msg },
    });
    return NextResponse.json({ error: "Error del servidor al registrar la venta" }, { status: 500 });
  }
}

/**
 * Historial de ventas de un día.
 *  - admin: cualquier fecha (?date=YYYY-MM-DD), todos los cajeros, con el detalle del error.
 *  - cajero: SOLO sus propias ventas, y solo de HOY o AYER (cualquier otra fecha se trata como hoy), sin el detalle técnico del error.
 */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const user = g.user;

  await sweepStuckInvoicing().catch(() => {});
  const isAdmin = user.role === "admin";
  const param = new URL(req.url).searchParams.get("date");
  const today = todayBogota();
  const date = isDateStr(param) && (isAdmin || param === today || param === yesterdayBogota()) ? param : today;
  const rf = new URL(req.url).searchParams.get("comprobante");
  const rows = await listSales(date, isAdmin ? null : user.uid, isReceiptFilter(rf) ? rf : "todos");

  const sales = isAdmin ? rows : rows.map((r) => ({ ...r, last_error: null }));
  return NextResponse.json({ date, role: user.role, sales }, { headers: { "Cache-Control": "no-store" } });
}
