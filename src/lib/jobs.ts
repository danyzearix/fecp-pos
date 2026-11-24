// Tareas de fondo dentro de la app (sin cron externo). Se arrancan una sola vez desde src/instrumentation.ts.
// Cada tarea decide por sí misma, con un bloqueo en la base, si le toca correr: aunque haya varios procesos o reinicios,
// la retención corre como mucho UNA vez por día.
import { runDailyReceiptRetention } from "./receipts";
import { getEpaycoConfig } from "./epayco/config";
import { pollWaitingPayments } from "./epayco/poller";
import { query } from "./db";
import { startProductSync } from "./siigo/product-sync";
import { stockSyncMinutes } from "./warehouse";

const HOUR = 60 * 60_000;
const g = globalThis as unknown as { __fecpJobsStarted?: boolean };

async function tick() {
  try {
    await runDailyReceiptRetention();
  } catch (e) {
    // Nunca tumba el servidor; se reintenta en la próxima hora
    console.error("[tareas] retención de comprobantes falló:", e instanceof Error ? e.message : e);
  }
}

/**
 * Sincronización AUTOMÁTICA de productos de Siigo. Solo corre después de que un admin hizo la primera sincronización completa a mano.
 *  - Una vez al día de madrugada (2:00–5:59 hora de Colombia): catálogo completo + existencias.
 *  - Existencias de todas las bodegas cada N minutos (Admin → Configuración; 30 por defecto; 0 = apagado).
 * Usa el mismo candado que el botón manual y que WooCommerce: si hay otra sincronización en curso, simplemente espera al próximo turno.
 */
async function tickSiigoProducts() {
  if (!process.env.SIIGO_USERNAME) return;
  const last = await query<{ kind: string; status: string; done_today: boolean; age_min: number }>(
    `SELECT kind, status, ((finished_at AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date) AS done_today,
            extract(epoch FROM (now() - finished_at)) / 60 AS age_min
       FROM product_sync_runs WHERE status <> 'running' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 50`
  );
  const fullEver = (await query("SELECT 1 FROM product_sync_runs WHERE status = 'done' AND kind = 'completa' LIMIT 1")).rowCount === 1;
  if (!fullEver) return;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hour12: false }).format(new Date()));
  // un intento que falló también cuenta como «ya se intentó hace poco»: no se reintenta cada 5 minutos
  const fullToday = last.rows.some((r) => r.kind === "completa" && r.done_today && (r.status === "done" || Number(r.age_min) < 60));
  if (hour >= 2 && hour < 6 && !fullToday) {
    await startProductSync({ kind: "completa", trigger: "automatica", userId: null });
    return;
  }
  const mins = await stockSyncMinutes();
  if (mins > 0) {
    const youngest = last.rows.length ? Math.min(...last.rows.map((r) => Number(r.age_min))) : Infinity;
    if (youngest >= mins) await startProductSync({ kind: "existencias", trigger: "automatica", userId: null });
  }
}

export function startBackgroundJobs() {
  if (g.__fecpJobsStarted) return;
  g.__fecpJobsStarted = true;
  // Primera revisión 1 minuto después de arrancar (deja que la base y el servidor queden listos) y luego cada hora.
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), HOUR).unref();
  // Productos de Siigo: se revisa cada 5 minutos si toca la sincronización diaria o la de existencias
  setInterval(() => void tickSiigoProducts().catch((e) => console.error("[tareas] sincronización automática de Siigo falló:", e instanceof Error ? e.message : e)), 5 * 60_000).unref();
  // Consulta activa a ePayco de los cobros que siguen esperando (cada EPAYCO_POLL_SECONDS; 0 = apagada)
  const secs = getEpaycoConfig().pollSeconds;
  if (secs > 0) {
    setInterval(() => void pollWaitingPayments().catch((e) => console.error("[tareas] consulta activa de pagos falló:", e instanceof Error ? e.message : e)), secs * 1000).unref();
  }
}
