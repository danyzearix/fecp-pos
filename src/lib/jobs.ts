// Tareas de fondo dentro de la app (sin cron externo). Se arrancan una sola vez desde src/instrumentation.ts.
// Cada tarea decide por sí misma, con un bloqueo en la base, si le toca correr: aunque haya varios procesos o reinicios,
// la retención corre como mucho UNA vez por día.
import { runDailyReceiptRetention } from "./receipts";

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

export function startBackgroundJobs() {
  if (g.__fecpJobsStarted) return;
  g.__fecpJobsStarted = true;
  // Primera revisión 1 minuto después de arrancar (deja que la base y el servidor queden listos) y luego cada hora.
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), HOUR).unref();
}
