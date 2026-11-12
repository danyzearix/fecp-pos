import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";

// GET /api/customers?q=123  → busca por identificación (prefijo) o nombre. Máx. 8 resultados.
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ customers: [] });

  // Escapar comodines de LIKE escritos por el usuario
  const like = q.replace(/[\\%_]/g, "\\$&");
  const { rows } = await query(
    `SELECT id, id_type, identification, check_digit, first_name, last_name, company_name,
            email, phone, address, state_code, city_code
       FROM customers
      WHERE identification LIKE $1 || '%'
         OR (coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(company_name,'')) ILIKE '%' || $1 || '%'
      ORDER BY identification LIMIT 8`,
    [like]
  );
  return NextResponse.json({ customers: rows });
}
