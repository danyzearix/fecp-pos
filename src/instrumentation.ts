// Next.js llama a register() UNA vez al arrancar cada servidor. Aquí solo se encienden las tareas de fondo
// (retención diaria de comprobantes), y solo en el runtime de Node (no en el de Edge ni durante `next build`).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startBackgroundJobs } = await import("./lib/jobs");
  startBackgroundJobs();
}
