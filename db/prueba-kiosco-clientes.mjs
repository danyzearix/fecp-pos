// Regresión de PRIVACIDAD del kiosco: el rol "cliente" no puede leer, buscar ni autocompletar nada de la tabla customers.
//
//   node --env-file=.env.local db/prueba-kiosco-clientes.mjs [http://127.0.0.1:3000]
//
// Crea un usuario "cliente" temporal y un cliente de prueba (datos inventados), y comprueba que:
//   - /api/customers (con y sin búsqueda en vivo) y /api/admin/clientes/sync responden 403 al kiosco;
//   - el cobro del kiosco con la cédula de un cliente existente NO modifica a ese cliente ni devuelve sus datos;
//   - la tirilla del kiosco de una venta de un cliente existente solo muestra "***" + 3 últimos dígitos (nunca el nombre guardado).
// Al terminar borra todo lo que creó. Sale con código 1 si algo falla. (Con EPAYCO_TEST_MODE=true el cobro es una sesión de prueba.)
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const suffix = crypto.randomBytes(4).toString("hex");
const email = `tmp-kiosco-cli-${suffix}@prueba.test`;
const password = "Prueba-" + crypto.randomBytes(8).toString("hex");
const IDENT = "9" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // cédula inventada
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (t, v) => (await db.query(t, v)).rows;
let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) failed = true;
};

try {
  await q("INSERT INTO users (name, email, password_hash, role, active) VALUES ('Prueba kiosco clientes', $1, $2, 'cliente', true)", [email, await bcrypt.hash(password, 10)]);
  await q(
    "INSERT INTO customers (id_type, identification, first_name, last_name, email, address, state_code, city_code, siigo_synced) VALUES ('13', $1, 'Nombre', 'Guardado', 'guardado@ejemplo.test', 'Calle guardada 1', '11', '11001', true)",
    [IDENT]
  );
  const hash = async () => (await q("SELECT md5(row(c.*)::text) AS h FROM customers c WHERE identification = $1", [IDENT]))[0].h;
  const h0 = await hash();
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!login.ok || !cookie) throw new Error(`no se pudo iniciar sesión (${login.status})`);
  const get = (p, init = {}) => fetch(BASE + p, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) }, redirect: "manual" });

  for (const p of [`/api/customers?q=${IDENT}`, "/api/customers?q=Nombre", "/api/customers", `/api/customers?q=${IDENT}&live=1`, "/api/admin/clientes/sync"]) {
    const r = await get(p);
    const body = await r.text();
    check(`kiosco: GET ${p.replace(IDENT, "<cédula>")} → 403 y sin datos`, r.status === 403 && !body.includes("Guardado") && !body.includes(IDENT), `HTTP ${r.status}`);
  }
  const post = await get("/api/admin/clientes/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("kiosco: POST /api/admin/clientes/sync → 403", post.status === 403, `HTTP ${post.status}`);
  const page = await get("/admin/clientes");
  check("kiosco: la página /admin/clientes lo redirige", page.status >= 300 && page.status < 400, `HTTP ${page.status}`);

  const p = (await q("SELECT id FROM products WHERE active AND sku IS NOT NULL AND sku <> '' AND price > 1000 ORDER BY id LIMIT 1"))[0];
  const res = await get("/api/kiosco/pagos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ product_id: p.id, quantity: 1 }], checkout_type: "corto", customer: { id_type: "13", identification: IDENT, first_name: "Otro", last_name: "Nombre", email: "otro@ejemplo.test" } }),
  });
  const text = await res.text();
  const sale = (await q("SELECT s.id, s.customer_id FROM sales s JOIN users u ON u.id = s.cashier_id WHERE u.email = $1", [email]))[0];
  check("el kiosco cobra con la cédula de un cliente existente", res.ok && !!sale, `HTTP ${res.status}`);
  check("la respuesta no trae el nombre, correo ni dirección guardados", !/Guardado|guardado@|Calle guardada/.test(text));
  check("el cliente guardado NO se modificó (ni nombre ni correo)", (await hash()) === h0);
  if (sale) {
    const st = await (await get(`/api/kiosco/pagos/${sale.id}`)).text();
    check("el estado del cobro tampoco trae datos del cliente guardado", !/Guardado|guardado@|Calle guardada/.test(st));
    // Tirilla: solo se entrega con la venta facturada; se simula para comprobar que no filtra el nombre guardado
    await q("UPDATE sales SET status = 'invoiced', invoice_name = 'FV-PRUEBA' WHERE id = $1", [sale.id]);
    const tr = await get(`/api/kiosco/pagos/${sale.id}/ticket`);
    const t = await tr.json();
    check("tirilla del kiosco: sin el nombre guardado y con el documento enmascarado", tr.ok && !JSON.stringify(t).includes("Guardado") && t.ticket.customer_identification === "***" + IDENT.slice(-3), `${t.ticket?.customer_name} ${t.ticket?.customer_identification}`);
  }
  const bad = await get("/api/kiosco/pagos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ product_id: p.id, quantity: 1 }], checkout_type: "corto", customer: { id_type: "42", identification: "55512345", first_name: "A", last_name: "B" } }),
  });
  check("el kiosco no acepta los tipos de documento extra (solo la caja): 42 → 400", bad.status === 400, `HTTP ${bad.status}`);
} catch (e) {
  console.log("ERROR:", e instanceof Error ? e.message : e);
  failed = true;
} finally {
  const ids = (await q("SELECT s.id FROM sales s JOIN users u ON u.id = s.cashier_id WHERE u.email = $1", [email])).map((r) => r.id);
  if (ids.length) {
    await q("DELETE FROM payment_refs WHERE sale_id = ANY($1::uuid[])", [ids]);
    await q("DELETE FROM sales WHERE id = ANY($1::uuid[])", [ids]);
  }
  await q("DELETE FROM customers WHERE identification IN ($1, '55512345')", [IDENT]);
  await q("DELETE FROM users WHERE email = $1", [email]);
  await db.end();
  console.log(failed ? "\nRESULTADO: FALLÓ — el kiosco podría estar leyendo o modificando clientes" : "\nRESULTADO: OK — el kiosco no lee ni modifica la tabla de clientes");
  process.exit(failed ? 1 : 0);
}
