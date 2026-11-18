import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { siigo, siigoTestConnection } from "@/lib/siigo/client";
import { explicitCreditPaymentId, siigoPaymentId } from "@/lib/siigo/payment";
import { wooGet, wooTestConnection } from "@/lib/woo";

type Check = { name: string; ok: boolean; detail: string };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** POST /api/admin/test/woo | /api/admin/test/siigo — solo admin. Nunca devuelve credenciales ni tokens. */
export async function POST(req: Request, ctx: { params: Promise<{ service: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { service } = await ctx.params;
  const checks: Check[] = [];

  if (service === "woo") {
    try {
      const r = await wooTestConnection();
      checks.push({ name: "Conexión y credenciales", ok: true, detail: `Precios de la tienda ${r.pricesIncludeTax ? "incluyen" : "NO incluyen"} IVA` });
      const p = await wooGet<unknown[]>("/products", { per_page: 1, status: "publish" });
      checks.push({ name: "Productos publicados", ok: true, detail: `${p.totalPages} productos` });
    } catch (e) {
      checks.push({ name: "Conexión con WooCommerce", ok: false, detail: msg(e) });
    }
  } else if (service === "siigo") {
    try {
      await siigoTestConnection();
      checks.push({ name: "Autenticación (token)", ok: true, detail: "Credenciales válidas" });
    } catch (e) {
      checks.push({ name: "Autenticación (token)", ok: false, detail: msg(e) });
    }
    if (checks[0].ok) {
      const test = process.env.SIIGO_TEST_MODE === "true";
      const docId = Number(test ? process.env.SIIGO_TEST_DOCUMENT_ID : process.env.SIIGO_DOCUMENT_ID);
      try {
        const docs = await siigo<{ id: number; name: string; electronic_type: string; active: boolean }[]>("GET", "/v1/document-types?type=FV");
        const d = docs.find((x) => x.id === docId);
        checks.push({
          name: `Comprobante ${test ? "de prueba (SIIGO_TEST_DOCUMENT_ID)" : "(SIIGO_DOCUMENT_ID)"} = ${docId}`,
          ok: !!d && d.active,
          detail: d ? `${d.name} (${d.electronic_type})${d.active ? "" : " — INACTIVO"}` : "No existe en Siigo",
        });
      } catch (e) {
        checks.push({ name: "Comprobante de venta", ok: false, detail: msg(e) });
      }
      // Formas de pago: que el Crédito FECP exista, esté activo y exija fecha de vencimiento (due_date), como pide Siigo
      try {
        const pts = await siigo<{ id: number; name: string; active: boolean; due_date: boolean }[]>("GET", "/v1/payment-types?document_type=FV");
        const creditId = siigoPaymentId("credito_fecp");
        const pt = pts.find((x) => x.id === creditId);
        checks.push({
          name: `Forma de pago del Crédito FECP = ${creditId}${explicitCreditPaymentId() ? "" : " (por defecto de pruebas)"}`,
          ok: !!pt && pt.active && pt.due_date,
          detail: pt ? `${pt.name}${pt.active ? "" : " — INACTIVA"}${pt.due_date ? " · con fecha de vencimiento ✓" : " — NO maneja fecha de vencimiento (due_date): no sirve para crédito"}` : "No existe en Siigo",
        });
        for (const m of ["efectivo", "tarjeta", "transferencia"] as const) {
          const id = siigoPaymentId(m);
          const x = pts.find((y) => y.id === id);
          checks.push({ name: `Forma de pago de ${m} = ${id}`, ok: !!x && x.active, detail: x ? `${x.name}${x.active ? "" : " — INACTIVA"}` : "No existe en Siigo" });
        }
      } catch (e) {
        checks.push({ name: "Formas de pago", ok: false, detail: msg(e) });
      }
      try {
        const users = await siigo<{ results?: { id: number; first_name: string; last_name: string; active: boolean }[] } | { id: number; first_name: string; last_name: string; active: boolean }[]>("GET", "/v1/users");
        const list = Array.isArray(users) ? users : users.results ?? [];
        const sellers = new Set<number>();
        if (process.env.SIIGO_SELLER_ID) sellers.add(Number(process.env.SIIGO_SELLER_ID));
        const db = await query<{ siigo_seller_id: number }>("SELECT DISTINCT siigo_seller_id FROM users WHERE active AND siigo_seller_id IS NOT NULL");
        db.rows.forEach((r) => sellers.add(r.siigo_seller_id));
        for (const id of sellers) {
          const u = list.find((x) => x.id === id);
          checks.push({
            name: `Vendedor Siigo ${id}`,
            ok: !!u && u.active,
            detail: u ? `${u.first_name} ${u.last_name}${u.active ? "" : " — INACTIVO"}` : "No existe en Siigo",
          });
        }
      } catch (e) {
        checks.push({ name: "Vendedores", ok: false, detail: msg(e) });
      }
    }
  } else {
    return NextResponse.json({ error: "Servicio desconocido (woo | siigo)" }, { status: 404 });
  }

  const ok = checks.every((c) => c.ok);
  await writeLog("admin", `Prueba de conexión ${service}: ${ok ? "OK" : "con problemas"}`, {
    level: ok ? "info" : "warn",
    userId: g.user.uid,
    detail: { checks },
  });
  return NextResponse.json({ ok, checks });
}
