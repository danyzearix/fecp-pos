// Regresión de PRIVACIDAD del kiosco: el rol "cliente" no puede leer clientes, solo consultar el suyo y recibir datos ENMASCARADOS.
//
//   node --env-file=.env.local db/prueba-kiosco-clientes.mjs [http://127.0.0.1:3000]
//
// Crea un usuario "cliente" temporal y un cliente de prueba (datos inventados), y comprueba que:
//   - /api/customers (la búsqueda de la caja) y /api/admin/clientes/sync responden 403 al kiosco;
//   - POST /api/kiosco/cliente responde SOLO { found, name_masked, identification_masked } (nunca nombre, correo ni teléfono reales);
//   - todo lo demás ("no existe", formato inválido, búsqueda parcial) responde igual: { found: false };
//   - el cobro del kiosco con la cédula de un cliente existente NO lo modifica, aunque el navegador mande otro nombre, otro id de
//     Siigo u otro customer_id, y no devuelve sus datos;
//   - la tirilla del kiosco solo muestra "***" + 3 dígitos (nunca el nombre guardado).
// Al terminar borra todo lo que creó. Sale con código 1 si algo falla. (Con EPAYCO_TEST_MODE=true el cobro es una sesión de prueba.)
// Una consulta de cliente inexistente hace UNA lectura (GET) en Siigo; no escribe nada.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const suffix = crypto.randomBytes(4).toString("hex");
const email = `tmp-kiosco-cli-${suffix}@prueba.test`;
const password = "Prueba-" + crypto.randomBytes(8).toString("hex");
const IDENT = "9" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // cédula inventada
const OTHER = "8" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const IP = `10.${20 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.1`; // IP de la prueba (para no gastar el cupo de otros)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (t, v) => (await db.query(t, v)).rows;
let failed = false;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) failed = true;
};
const LEAK = /Nombre|Guardado|guardado@|3001234567|Calle guardada|sid-prueba/;

try {
  await q("INSERT INTO users (name, email, password_hash, role, active) VALUES ('Prueba kiosco clientes', $1, $2, 'cliente', true)", [email, await bcrypt.hash(password, 10)]);
  await q(
    `INSERT INTO customers (id_type, identification, first_name, last_name, email, phone, address, state_code, city_code, siigo_id, siigo_synced)
     VALUES ('13', $1, 'Nombre', 'Guardado Prueba', 'guardado@ejemplo.test', '3001234567', 'Calle guardada 1', '11', '11001', 'sid-prueba', true)`,
    [IDENT]
  );
  await q("INSERT INTO customers (id_type, identification, first_name, last_name, siigo_synced) VALUES ('13', $1, 'Otro', 'Cliente', true)", [OTHER]);
  const hash = async (id) => (await q("SELECT md5(row(c.*)::text) AS h FROM customers c WHERE identification = $1", [id]))[0].h;
  const h0 = await hash(IDENT);
  const h1 = await hash(OTHER);
  const idOther = (await q("SELECT id FROM customers WHERE identification = $1", [OTHER]))[0].id;
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!login.ok || !cookie) throw new Error(`no se pudo iniciar sesión (${login.status})`);
  const call = (p, init = {}) => fetch(BASE + p, { ...init, headers: { Cookie: cookie, "x-forwarded-for": IP, ...(init.headers ?? {}) }, redirect: "manual" });
  const post = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // 1) La búsqueda de la caja y la sincronización están cerradas para el kiosco
  for (const p of [`/api/customers?identification=${IDENT}`, "/api/customers?q=Nombre", "/api/customers", "/api/admin/clientes/sync"]) {
    const r = await call(p);
    const body = await r.text();
    check(`kiosco: GET ${p.replace(IDENT, "<cédula>")} → 403 y sin datos`, r.status === 403 && !LEAK.test(body) && !body.includes(IDENT), `HTTP ${r.status}`);
  }
  check("kiosco: POST /api/admin/clientes/sync → 403", (await post("/api/admin/clientes/sync", {})).status === 403);
  check("kiosco: la página /admin/clientes lo redirige", (await call("/admin/clientes")).status >= 300);

  // 2) Su propia consulta: solo datos enmascarados
  const t0 = Date.now();
  const r1 = await post("/api/kiosco/cliente", { identification: IDENT });
  const text1 = await r1.text();
  const d1 = JSON.parse(text1);
  check("existe → { found, name_masked, identification_masked } y nada más", r1.ok && JSON.stringify(Object.keys(d1).sort()) === '["found","identification_masked","name_masked"]', text1);
  check("máscara del nombre: 3 letras + 4 asteriscos por palabra", d1.name_masked === "NOM**** GUA**** PRU****", d1.name_masked);
  check("máscara de la cédula: 4 dígitos + 4 asteriscos", d1.identification_masked === IDENT.slice(0, 4) + "****", d1.identification_masked);
  check("la respuesta no contiene nombre, correo, teléfono, dirección ni la cédula completa", !LEAK.test(text1) && !text1.includes(IDENT));
  const others = [];
  for (const id of [OTHER.slice(0, 5), "abc12", ""]) others.push(await (await post("/api/kiosco/cliente", { identification: id })).text());
  check("búsqueda parcial / formato inválido / vacío → exactamente { found: false }", others.every((t) => t === '{"found":false}'), others.join(" "));
  const t1 = Date.now();
  const r3 = await post("/api/kiosco/cliente", { identification: "7" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0") });
  const dt = Date.now() - t1;
  check("no existe → { found: false } con la misma forma y un tiempo mínimo parejo (≥ 1,1 s)", (await r3.text()) === '{"found":false}' && dt >= 1100, `${dt} ms`);

  // 3) Cobro del kiosco: el navegador no puede forzar otro cliente ni modificar al existente
  const p = (await q("SELECT id FROM products WHERE active AND sku IS NOT NULL AND sku <> '' AND price > 1000 ORDER BY id LIMIT 1"))[0];
  const res = await post("/api/kiosco/pagos", {
    items: [{ product_id: p.id, quantity: 1 }], checkout_type: "corto", channel: "pantalla",
    customer: { id_type: "13", identification: IDENT, first_name: "Falso", last_name: "Nombre", email: "falso@ejemplo.test", siigo_id: "otro", id: idOther, customer_id: idOther },
    customer_id: idOther, siigo_id: "otro",
  });
  const text = await res.text();
  const sale = (await q("SELECT s.id, c.identification FROM sales s JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.cashier_id WHERE u.email = $1", [email]))[0];
  check("el cobro queda con el cliente de la CÉDULA (no el que el navegador quiso forzar)", res.ok && sale?.identification === IDENT, `HTTP ${res.status}`);
  check("la respuesta del cobro no trae el nombre, correo ni dirección guardados", !LEAK.test(text));
  check("ningún cliente se modificó (ni el de la cédula ni el que se quiso forzar)", (await hash(IDENT)) === h0 && (await hash(OTHER)) === h1);
  if (sale) {
    const st = await (await call(`/api/kiosco/pagos/${sale.id}`)).text();
    check("el estado del cobro tampoco trae datos del cliente guardado", !LEAK.test(st));
    await q("UPDATE sales SET status = 'invoiced', invoice_name = 'FV-PRUEBA' WHERE id = $1", [sale.id]);
    const tr = await call(`/api/kiosco/pagos/${sale.id}/ticket`);
    const t = await tr.json();
    check("tirilla del kiosco: sin el nombre guardado y con el documento enmascarado", tr.ok && !JSON.stringify(t).includes("Guardado") && t.ticket.customer_identification === "***" + IDENT.slice(-3), `${t.ticket?.customer_name} ${t.ticket?.customer_identification}`);
  }
  const bad = await post("/api/kiosco/pagos", { items: [{ product_id: p.id, quantity: 1 }], customer: { id_type: "42", identification: "55512345", first_name: "A", last_name: "B", email: "a@b.co", address: "x", state_code: "11", city_code: "11001" } });
  check("el kiosco no acepta los tipos de documento extra (solo la caja): 42 → 400", bad.status === 400, `HTTP ${bad.status}`);
  void t0;
} catch (e) {
  console.log("ERROR:", e instanceof Error ? e.message : e);
  failed = true;
} finally {
  const ids = (await q("SELECT s.id FROM sales s JOIN users u ON u.id = s.cashier_id WHERE u.email = $1", [email])).map((r) => r.id);
  if (ids.length) {
    await q("DELETE FROM payment_refs WHERE sale_id = ANY($1::uuid[])", [ids]);
    await q("DELETE FROM sales WHERE id = ANY($1::uuid[])", [ids]);
  }
  await q("DELETE FROM customers WHERE identification IN ($1, $2, '55512345')", [IDENT, OTHER]);
  await q("DELETE FROM users WHERE email = $1", [email]);
  await db.end();
  console.log(failed ? "\nRESULTADO: FALLÓ — el kiosco podría estar leyendo o modificando clientes" : "\nRESULTADO: OK — el kiosco solo ve datos enmascarados y no modifica clientes");
  process.exit(failed ? 1 : 0);
}
