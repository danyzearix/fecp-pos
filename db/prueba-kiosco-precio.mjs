// Regresión de SEGURIDAD del kiosco: el precio, el IVA y el total salen SIEMPRE de la tabla products, nunca del navegador.
//
//   node --env-file=.env.local db/prueba-kiosco-precio.mjs [http://127.0.0.1:3000]
//
// Crea un usuario "cliente" temporal, intenta pagar un producto mandando price=1, unit_price=1, tax_rate=0 y total=1, y comprueba
// que la venta se guardó con el precio y el IVA REALES. Al terminar borra la venta y el usuario que creó. Sale con código 1 si falla.
// OJO: el kiosco crea el cobro en ePayco (con EPAYCO_TEST_MODE=true es una sesión de prueba, no cobra dinero).
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const email = `tmp-kiosco-${crypto.randomBytes(4).toString("hex")}@prueba.test`;
const password = "Prueba-" + crypto.randomBytes(8).toString("hex");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (t, v) => (await db.query(t, v)).rows;
let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) failed = true;
};

let saleId = null;
try {
  await q("INSERT INTO users (name, email, password_hash, role, active) VALUES ('Prueba kiosco', $1, $2, 'cliente', true)", [email, await bcrypt.hash(password, 10)]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!login.ok || !cookie) throw new Error(`no se pudo iniciar sesión (${login.status})`);

  const p = (await q("SELECT id, name, price::float8 AS price, tax_rate, prices_include_tax FROM products WHERE active AND sku IS NOT NULL AND sku <> '' AND price > 1000 ORDER BY id LIMIT 1"))[0];
  const real = p.prices_include_tax ? p.price : Math.round(p.price * (1 + p.tax_rate / 100) * 100) / 100;

  const res = await fetch(`${BASE}/api/kiosco/pagos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      items: [{ product_id: p.id, quantity: 1, price: 1, unit_price: 1, tax_rate: 0, prices_include_tax: false, line_total: 1, name: "regalo" }],
      total: 1, amount: 1, subtotal: 1, checkout_type: "corto", customer: null,
    }),
  });
  const sale = (await q("SELECT s.id, s.total::float8 AS total, s.price_review_status FROM sales s JOIN users u ON u.id = s.cashier_id WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1", [email]))[0];
  if (!sale) throw new Error(`el kiosco no guardó la venta (HTTP ${res.status})`);
  saleId = sale.id;
  const line = (await q("SELECT unit_price::float8 AS up, tax_rate, name FROM sale_items WHERE sale_id = $1", [saleId]))[0];

  console.log(`Producto en la base: ${p.name} · precio ${p.price} · IVA ${p.tax_rate}% · incluye IVA: ${p.prices_include_tax}`);
  check("el total guardado es el REAL (no $1)", sale.total === real, `guardado ${sale.total} · esperado ${real}`);
  check("el precio de la línea es el de la base", line.up === p.price, `${line.up}`);
  check("el IVA de la línea es el de la base (no 0)", line.tax_rate === p.tax_rate, `${line.tax_rate}%`);
  check("el nombre es el de la base (no el que mandó el navegador)", line.name === p.name);

  for (const [label, items] of [["cantidad 0", [{ product_id: p.id, quantity: 0 }]], ["cantidad negativa", [{ product_id: p.id, quantity: -1 }]], ["producto inexistente", [{ product_id: 99999999, quantity: 1 }]]]) {
    const r = await fetch(`${BASE}/api/kiosco/pagos`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ items, checkout_type: "corto", customer: null }) });
    check(`${label} → rechazado (400)`, r.status === 400, `HTTP ${r.status}`);
  }
} catch (e) {
  console.log("ERROR:", e instanceof Error ? e.message : e);
  failed = true;
} finally {
  // limpieza: la venta de prueba y el usuario temporal
  const ids = (await q("SELECT s.id FROM sales s JOIN users u ON u.id = s.cashier_id WHERE u.email = $1", [email])).map((r) => r.id);
  if (ids.length) {
    await q("DELETE FROM payment_refs WHERE sale_id = ANY($1::uuid[])", [ids]);
    await q("DELETE FROM sales WHERE id = ANY($1::uuid[])", [ids]);
  }
  await q("DELETE FROM users WHERE email = $1", [email]);
  await db.end();
  console.log(failed ? "\nRESULTADO: FALLÓ — el kiosco podría estar aceptando valores del navegador" : "\nRESULTADO: OK — el kiosco usa siempre el precio, el IVA y el total de la base");
  process.exit(failed ? 1 : 0);
}
