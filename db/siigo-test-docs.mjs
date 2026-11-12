// npm run siigo:pruebas → lista los documentos de PRUEBA creados en Siigo por el POS
// (documento 6503 no electrónico, observaciones "PRUEBA POS - ELIMINAR ..."), para que el contador los anule o elimine.
import pg from "pg";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  SELECT DISTINCT ON (l.created_at::date, l.detail->>'siigo_invoice_id')
         l.created_at, l.detail->>'siigo_name' AS siigo_name, l.detail->>'siigo_invoice_id' AS siigo_id,
         COALESCE(s.local_number, l.detail->>'local_number') AS local_number,
         COALESCE(s.total::float8, (l.detail->>'total')::float8) AS total
    FROM logs l
    LEFT JOIN sales s ON s.id::text = l.detail->>'sale_id'
   WHERE l.type = 'factura' AND l.detail->>'test_document' = 'true'
   ORDER BY l.created_at::date, l.detail->>'siigo_invoice_id', l.created_at`);
rows.sort((a, b) => a.created_at - b.created_at);
await c.end();

if (!rows.length) {
  console.log("No hay documentos de prueba registrados.");
} else {
  console.log(`${rows.length} documento(s) de PRUEBA creados en Siigo (anular o eliminar en Siigo Nube):\n`);
  console.table(
    rows.map((r) => ({
      fecha: r.created_at.toLocaleString("es-CO", { timeZone: "America/Bogota" }),
      documento_siigo: r.siigo_name,
      venta_pos: r.local_number,
      total: r.total,
      id_siigo: r.siigo_id,
    }))
  );
  console.log('En Siigo Nube: buscar el número (ej. FV-1-25603) → abrir → "Anular" o "Eliminar".');
}
