// Sincronización de clientes Siigo → POS (UNA sola dirección: Siigo manda). SOLO LEE de Siigo (GET /v1/customers):
// nunca crea ni modifica nada allá.
//
//  - Trae solo terceros de tipo CLIENTE (filtro `type=Customer` de Siigo; ese filtro ya excluye las sucursales: se usa la principal).
//  - Corre en segundo plano dentro de la app, por páginas de 100 (sin cargar todo en memoria), a máximo 40 peticiones por minuto
//    y cediendo el paso a la facturación (comparte la ventana de peticiones de src/lib/siigo/client.ts).
//  - UNA corrida a la vez: bloqueo en la base (índice único parcial sobre customer_sync_runs). Si el proceso muere queda
//    'running' con el latido viejo y se puede RETOMAR desde la última página guardada.
//  - La primera vez trae todo; las siguientes piden solo lo modificado/creado desde la última corrida con 1 día de traslape.
//  - Los logs llevan SOLO conteos: nunca nombres, documentos ni correos.
import crypto from "node:crypto";
import { SIIGO_CUSTOMER_SYNC_PER_MINUTE, SIIGO_CUSTOMER_SYNC_YIELD_ABOVE } from "@/config/siigo-map";
import { PICKER_COLUMNS, type PickerRow } from "../customers";
import { pool, query } from "../db";
import { writeLog } from "../log";
import { CONSUMIDOR_FINAL_ID } from "../sale-types";
import { testHooksEnabled } from "../test-hooks";
import { SiigoHttpError, SiigoNetworkError, siigo, siigoRequestsLastMinute } from "./client";

const PAGE_SIZE = 100; // máximo real de Siigo (comprobado: pedir más devuelve 100)
const MAX_RETRIES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[0-9A-Za-z-]{3,20}$/; // la misma regla de la caja (parseCustomer)

/** Los valores de ritmo solo se pueden cambiar en desarrollo/pruebas (en producción se ignoran: siempre 40 por minuto). */
const tune = (name: string, def: number) => {
  if (!testHooksEnabled()) return def;
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const perMinute = () => tune("CUSTOMER_SYNC_PER_MINUTE", SIIGO_CUSTOMER_SYNC_PER_MINUTE);
const retryBaseMs = () => tune("CUSTOMER_SYNC_RETRY_MS", 20_000);
/** Una corrida 'running' cuyo latido tiene más de esto se considera caída (el proceso murió) y se puede retomar. */
const staleSeconds = () => tune("CUSTOMER_SYNC_STALE_SECONDS", 180);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mapeo Siigo → customers (solo lo necesario para facturar)
// ---------------------------------------------------------------------------
export type MappedCustomer = {
  siigo_id: string;
  id_type: string;
  identification: string;
  check_digit: string;
  first_name: string;
  last_name: string;
  company_name: string;
  email: string;
  phone: string;
  address: string;
  state_code: string;
  city_code: string;
  active: boolean;
};
export type SkipReason = "sin_id_siigo" | "identificacion_invalida" | "consumidor_final" | "sin_tipo_documento" | "sin_nombre" | "duplicada" | "error_base_de_datos";

const clean = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

type SiigoCustomerRaw = {
  id?: unknown;
  identification?: unknown;
  check_digit?: unknown;
  id_type?: { code?: unknown } | null;
  person_type?: unknown;
  name?: unknown;
  active?: unknown;
  contacts?: { email?: unknown }[] | null;
  phones?: { number?: unknown }[] | null;
  address?: { address?: unknown; city?: { state_code?: unknown; city_code?: unknown } | null } | null;
};

export function mapSiigoCustomer(raw: unknown): { ok: true; value: MappedCustomer } | { ok: false; reason: SkipReason } {
  const c = (raw ?? {}) as SiigoCustomerRaw;
  const siigo_id = clean(c.id, 60);
  if (!siigo_id) return { ok: false, reason: "sin_id_siigo" };
  const identification = clean(c.identification, 40);
  if (!ID_RE.test(identification)) return { ok: false, reason: "identificacion_invalida" };
  if (identification === CONSUMIDOR_FINAL_ID) return { ok: false, reason: "consumidor_final" };
  const id_type = clean(c.id_type?.code, 4);
  if (!/^\d{2}$/.test(id_type)) return { ok: false, reason: "sin_tipo_documento" };
  const names = (Array.isArray(c.name) ? c.name : []).map((n) => clean(n, 150)).filter(Boolean);
  if (!names.length) return { ok: false, reason: "sin_nombre" };

  // Empresa (NIT o persona jurídica): razón social en un solo campo. Persona: nombres y apellidos por separado.
  const isCompany = id_type === "31" || c.person_type === "Company";
  const email = (Array.isArray(c.contacts) ? c.contacts : []).map((x) => clean(x?.email, 150)).find((e) => EMAIL_RE.test(e)) ?? "";
  const phone = (Array.isArray(c.phones) ? c.phones : []).map((x) => clean(x?.number, 30)).find(Boolean) ?? "";
  return {
    ok: true,
    value: {
      siigo_id,
      id_type,
      identification,
      check_digit: clean(c.check_digit, 2),
      first_name: isCompany ? "" : names[0],
      last_name: isCompany ? "" : names.slice(1).join(" "),
      company_name: isCompany ? names.join(" ") : "",
      email,
      phone,
      address: clean(c.address?.address, 256),
      state_code: clean(c.address?.city?.state_code, 5),
      city_code: clean(c.address?.city?.city_code, 5),
      active: c.active !== false,
    },
  };
}

// ---------------------------------------------------------------------------
// Guardado: un solo INSERT … ON CONFLICT por página. "Siigo manda": si Siigo trae un valor, reemplaza al del POS; si Siigo
// no trae correo/teléfono/dirección/ubicación, se conserva el que ya tenía el POS (el cajero pudo completarlo al vender).
// Solo se escribe si algo cambió realmente (una segunda corrida no toca ninguna fila).
// ---------------------------------------------------------------------------
type Applied = { created: number; updated: number; moved: number };

async function applyBatch(rows: MappedCustomer[]): Promise<Applied> {
  if (!rows.length) return { created: 0, updated: 0, moved: 0 };
  const col = <K extends keyof MappedCustomer>(k: K) => rows.map((r) => r[k]);
  const params = [
    col("siigo_id"), col("id_type"), col("identification"), col("check_digit"), col("first_name"), col("last_name"), col("company_name"),
    col("email"), col("phone"), col("address"), col("state_code"), col("city_code"), col("active"), CONSUMIDOR_FINAL_ID,
  ];
  const incoming = `unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::boolean[])
      AS i(siigo_id, id_type, identification, check_digit, first_name, last_name, company_name, email, phone, address, state_code, city_code, active)`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Si alguien cambió su número de documento en Siigo, es el MISMO cliente (mismo id de Siigo): se renombra su fila para no duplicarlo.
    const moved = await client.query(
      `UPDATE customers c SET identification = i.identification
         FROM ${incoming}
        WHERE c.siigo_id = i.siigo_id AND c.identification <> i.identification AND c.identification <> $14
          AND NOT EXISTS (SELECT 1 FROM customers x WHERE x.identification = i.identification)`,
      params
    );
    const up = await client.query<{ inserted: boolean }>(
      `INSERT INTO customers (siigo_id, id_type, identification, check_digit, first_name, last_name, company_name, email, phone, address, state_code, city_code, active, siigo_synced)
       SELECT i.siigo_id, i.id_type, i.identification, i.check_digit, i.first_name, i.last_name, i.company_name, i.email, i.phone, i.address, i.state_code, i.city_code, i.active, TRUE
         FROM ${incoming}
       ON CONFLICT (identification) DO UPDATE SET
         siigo_id     = EXCLUDED.siigo_id,
         id_type      = EXCLUDED.id_type,
         check_digit  = COALESCE(NULLIF(EXCLUDED.check_digit, ''), customers.check_digit),
         first_name   = EXCLUDED.first_name,
         last_name    = EXCLUDED.last_name,
         company_name = EXCLUDED.company_name,
         email        = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email),
         phone        = COALESCE(NULLIF(EXCLUDED.phone, ''), customers.phone),
         address      = COALESCE(NULLIF(EXCLUDED.address, ''), customers.address),
         state_code   = COALESCE(NULLIF(EXCLUDED.state_code, ''), customers.state_code),
         city_code    = COALESCE(NULLIF(EXCLUDED.city_code, ''), customers.city_code),
         active       = EXCLUDED.active,
         siigo_synced = TRUE
       WHERE customers.identification <> $14 AND (
            customers.siigo_id IS DISTINCT FROM EXCLUDED.siigo_id
         OR customers.id_type IS DISTINCT FROM EXCLUDED.id_type
         OR customers.check_digit IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.check_digit, ''), customers.check_digit)
         OR customers.first_name IS DISTINCT FROM EXCLUDED.first_name
         OR customers.last_name IS DISTINCT FROM EXCLUDED.last_name
         OR customers.company_name IS DISTINCT FROM EXCLUDED.company_name
         OR customers.email IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.email, ''), customers.email)
         OR customers.phone IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.phone, ''), customers.phone)
         OR customers.address IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.address, ''), customers.address)
         OR customers.state_code IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.state_code, ''), customers.state_code)
         OR customers.city_code IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.city_code, ''), customers.city_code)
         OR customers.active IS DISTINCT FROM EXCLUDED.active
         OR customers.siigo_synced IS DISTINCT FROM TRUE)
       RETURNING (xmax = 0) AS inserted`,
      params
    );
    await client.query("COMMIT");
    const created = up.rows.filter((r) => r.inserted).length;
    return { created, updated: up.rows.length - created, moved: moved.rowCount ?? 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

type Counters = {
  created: number; updated: number; unchanged: number; skipped: number; duplicates: number; errors: number;
  reasons: Record<string, number>;
  /** de los clientes que ya existían y cambiaron: cuántos por cada columna (solo conteos, nunca los valores) */
  changes: Record<string, number>;
};
const COMPARE = ["siigo_id", "id_type", "check_digit", "first_name", "last_name", "company_name", "email", "phone", "address", "state_code", "city_code", "active"] as const;
const KEEP_IF_EMPTY = new Set<string>(["check_digit", "email", "phone", "address", "state_code", "city_code"]); // Siigo vacío → se conserva el del POS

/** Cuenta, por columna, cuántos clientes YA existentes cambiarían con esta página (para el historial; no escribe nada). */
async function countChanges(batch: MappedCustomer[], c: Counters) {
  if (!batch.length) return;
  const old = await query<Record<string, unknown> & { identification: string }>(
    `SELECT identification, ${COMPARE.join(", ")} FROM customers WHERE identification = ANY($1::text[])`,
    [batch.map((b) => b.identification)]
  );
  const byId = new Map(old.rows.map((r) => [r.identification, r]));
  for (const b of batch) {
    const o = byId.get(b.identification);
    if (!o) continue;
    for (const k of COMPARE) {
      const next = KEEP_IF_EMPTY.has(k) && b[k] === "" ? o[k] : b[k];
      if ((o[k] ?? "") !== next) c.changes[k] = (c.changes[k] ?? 0) + 1;
    }
  }
}
const bump = (c: Counters, reason: SkipReason, n = 1) => {
  c.reasons[reason] = (c.reasons[reason] ?? 0) + n;
};

/**
 * Procesa los clientes de UNA página. `seen` (identificación → id de Siigo, solo de esta corrida) detecta identificaciones repetidas en Siigo:
 * se conserva la primera y se cuenta el resto. Si la página falla en la base, se reintenta fila por fila para no perder las buenas.
 */
async function processPage(results: unknown[], seen: Map<string, string>, c: Counters) {
  const batch: MappedCustomer[] = [];
  const inPage = new Set<string>();
  for (const raw of results) {
    const m = mapSiigoCustomer(raw);
    if (!m.ok) {
      c.skipped++;
      bump(c, m.reason);
      continue;
    }
    const v = m.value;
    const prev = seen.get(v.identification);
    if (prev !== undefined && prev !== v.siigo_id) {
      c.duplicates++; // la misma identificación con otro id de Siigo: se queda la primera
      bump(c, "duplicada");
      continue;
    }
    if (inPage.has(v.identification)) continue; // el mismo registro dos veces en la misma página
    inPage.add(v.identification);
    seen.set(v.identification, v.siigo_id);
    batch.push(v);
  }
  await countChanges(batch, c).catch(() => {}); // solo estadística: nunca frena la sincronización
  let applied: Applied;
  try {
    applied = await applyBatch(batch);
  } catch {
    applied = { created: 0, updated: 0, moved: 0 };
    for (const row of batch) {
      try {
        const a = await applyBatch([row]);
        applied.created += a.created;
        applied.updated += a.updated;
        applied.moved += a.moved;
      } catch {
        c.errors++;
        bump(c, "error_base_de_datos");
      }
    }
  }
  c.created += applied.created;
  c.updated += applied.updated + applied.moved;
  c.unchanged += Math.max(0, batch.length - applied.created - applied.updated - applied.moved);
}

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------
export type RunRow = {
  id: number;
  mode: "full" | "incremental";
  status: "running" | "done" | "interrupted" | "cancelled";
  phase: "main" | "updated" | "created";
  next_page: number;
  total_pages: number | null;
  total_results: number | null;
  since: string | null;
  started_by: number | null;
  owner: string | null;
  started_at: Date;
  heartbeat_at: Date;
  finished_at: Date | null;
  requests: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  duplicates: number;
  errors: number;
  skip_reasons: Record<string, number>;
  changes: Record<string, number>;
  error_message: string | null;
  stale?: boolean;
};

const RUN_COLS = `id, mode, status, phase, next_page, total_pages, total_results, since::text AS since, started_by, owner, started_at, heartbeat_at, finished_at,
  requests, created, updated, unchanged, skipped, duplicates, errors, skip_reasons, changes, error_message,
  (status = 'running' AND heartbeat_at < now() - ($1 || ' seconds')::interval) AS stale`;

const getRun = async (id: number) => (await query<RunRow>(`SELECT ${RUN_COLS} FROM customer_sync_runs WHERE id = $2`, [String(staleSeconds()), id])).rows[0] ?? null;

function pathFor(run: Pick<RunRow, "mode" | "phase" | "next_page" | "since">): string {
  let p = `/v1/customers?type=Customer&page=${run.next_page}&page_size=${PAGE_SIZE}`;
  if (run.mode === "incremental" && run.since) p += `&${run.phase === "created" ? "created_start" : "updated_start"}=${run.since}`;
  return p;
}

class LostLock extends Error {}

type Ctx = { runId: number; owner: string; lastRequestAt: number; requests: number };

async function beat(ctx: Ctx) {
  const r = await query("UPDATE customer_sync_runs SET heartbeat_at = now() WHERE id = $1 AND owner = $2 AND status = 'running'", [ctx.runId, ctx.owner]);
  if (!r.rowCount) throw new LostLock();
}

/** Ritmo: máximo `perMinute()` peticiones por minuto, y prioridad baja frente a la facturación. */
async function pace(ctx: Ctx) {
  const wait = ctx.lastRequestAt + 60_000 / perMinute() - Date.now();
  if (wait > 0) await sleep(wait);
  for (let i = 0; siigoRequestsLastMinute() > SIIGO_CUSTOMER_SYNC_YIELD_ABOVE; i++) {
    if (i % 10 === 0) await beat(ctx);
    await sleep(2_000);
  }
  ctx.lastRequestAt = Date.now();
}

type SiigoPage = { results?: unknown[]; pagination?: { total_results?: number } };

/** GET con espera y reintento si Siigo responde 429, un error temporal (5xx) o no se puede conectar. */
async function fetchPage(path: string, ctx: Ctx): Promise<SiigoPage> {
  for (let attempt = 0; ; attempt++) {
    await pace(ctx);
    ctx.requests++;
    try {
      return await siigo<SiigoPage>("GET", path);
    } catch (e) {
      const transient = e instanceof SiigoNetworkError || (e instanceof SiigoHttpError && (e.status === 429 || e.status >= 500));
      if (!transient || attempt >= MAX_RETRIES) throw e;
      await beat(ctx);
      await sleep(retryBaseMs() * (attempt + 1));
      await beat(ctx);
    }
  }
}

const g = globalThis as unknown as { __custSyncLoops?: Set<number> };
const loops = () => (g.__custSyncLoops ??= new Set());

const counts = (r: RunRow) =>
  `creados ${r.created}, actualizados ${r.updated}, sin cambios ${r.unchanged}, omitidos ${r.skipped}, repetidos ${r.duplicates}, errores ${r.errors}`;

async function runLoop(runId: number, owner: string) {
  loops().add(runId);
  const ctx: Ctx = { runId, owner, lastRequestAt: 0, requests: 0 };
  const seen = new Map<string, string>();
  try {
    let run = await getRun(runId);
    if (!run || run.owner !== owner || run.status !== "running") return;
    const c: Counters = {
      created: run.created, updated: run.updated, unchanged: run.unchanged, skipped: run.skipped, duplicates: run.duplicates,
      errors: run.errors, reasons: { ...run.skip_reasons }, changes: { ...run.changes },
    };
    const baseRequests = run.requests;
    for (;;) {
      const data = await fetchPage(pathFor(run), ctx);
      const results = Array.isArray(data.results) ? data.results : [];
      const total = Number(data.pagination?.total_results ?? 0);
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      await processPage(results, seen, c);

      const endOfPhase = run.next_page >= pages || results.length === 0;
      let phase = run.phase;
      let nextPage = run.next_page + 1;
      let finished = false;
      if (endOfPhase) {
        if (run.mode === "incremental" && run.phase === "updated") {
          phase = "created"; // ahora los creados (los recién creados en Siigo aún no tienen fecha de modificación)
          nextPage = 1;
        } else finished = true;
      }
      const upd = await query<{ id: number }>(
        `UPDATE customer_sync_runs SET phase = $3, next_page = $4, total_pages = $5, total_results = $6,
                created = $7, updated = $8, unchanged = $9, skipped = $10, duplicates = $11, errors = $12, skip_reasons = $13::jsonb,
                requests = $14, heartbeat_at = now(), error_message = NULL, changes = $16::jsonb,
                status = CASE WHEN $15 THEN 'done' ELSE status END, finished_at = CASE WHEN $15 THEN now() ELSE NULL END
          WHERE id = $1 AND owner = $2 AND status = 'running' RETURNING id`,
        [runId, owner, phase, nextPage, pages, total, c.created, c.updated, c.unchanged, c.skipped, c.duplicates, c.errors, JSON.stringify(c.reasons), baseRequests + ctx.requests, finished, JSON.stringify(c.changes)]
      );
      if (!upd.rowCount) return; // otro proceso retomó la corrida: este se detiene
      run = (await getRun(runId))!;
      if (finished) {
        await writeLog("sync", `Sincronización de clientes TERMINADA (${run.mode === "full" ? "completa" : "incremental"}): ${counts(run)}`, {
          level: run.errors ? "warn" : "info",
          userId: run.started_by,
          detail: { run_id: runId, mode: run.mode, requests: run.requests, skip_reasons: run.skip_reasons, columnas_cambiadas: run.changes, total_en_siigo: run.total_results },
        });
        return;
      }
    }
  } catch (e) {
    if (e instanceof LostLock) return;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const r = await query<{ id: number }>(
      `UPDATE customer_sync_runs SET status = 'interrupted', error_message = $3, errors = errors + 1, requests = requests + $4, heartbeat_at = now()
        WHERE id = $1 AND owner = $2 AND status = 'running' RETURNING id`,
      [runId, owner, msg, ctx.requests]
    ).catch(() => null);
    if (r?.rowCount) {
      await writeLog("sync", `Sincronización de clientes INTERRUMPIDA (se puede retomar): ${msg}`, { level: "error", detail: { run_id: runId } });
    }
  } finally {
    loops().delete(runId);
  }
}

// ---------------------------------------------------------------------------
// API del módulo
// ---------------------------------------------------------------------------
export type StartResult =
  | { ok: true; runId: number; resumed: boolean; mode: "full" | "incremental" }
  | { ok: false; status: number; error: string; run?: RunRow | null };

const modeLabel = (m: string) => (m === "full" ? "completa" : "incremental");

/** Inicia (o retoma) la sincronización. Solo una a la vez: si ya hay una corriendo responde 409 con un mensaje claro. */
export async function startCustomerSync(opts: { userId: number; userName: string; full?: boolean }): Promise<StartResult> {
  if (!process.env.SIIGO_USERNAME || !process.env.SIIGO_ACCESS_KEY || !process.env.SIIGO_PARTNER_ID) {
    return { ok: false, status: 400, error: "Faltan las credenciales de Siigo en la configuración del servidor." };
  }
  const owner = crypto.randomBytes(12).toString("hex");
  const stale = String(staleSeconds());
  const busy = async (): Promise<StartResult> => {
    const cur = await query<{ id: number }>("SELECT id FROM customer_sync_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
    const run = cur.rows[0] ? await getRun(cur.rows[0].id) : null;
    const who = run?.started_by ? (await query<{ name: string }>("SELECT name FROM users WHERE id = $1", [run.started_by])).rows[0]?.name : null;
    return {
      ok: false,
      status: 409,
      error: run
        ? `Ya hay una sincronización de clientes en curso${who ? ` (iniciada por ${who})` : ""}${run.total_pages ? `, va en la página ${Math.min(run.next_page, run.total_pages)} de ${run.total_pages}` : ""}. Espera a que termine.`
        : "Ya hay una sincronización de clientes en curso. Espera a que termine.",
      run,
    };
  };

  const latest = (await query<RunRow>(`SELECT ${RUN_COLS} FROM customer_sync_runs ORDER BY id DESC LIMIT 1`, [stale])).rows[0] ?? null;
  if (latest?.status === "running" && !latest.stale) return busy();

  const resumable = latest && (latest.status === "interrupted" || (latest.status === "running" && latest.stale));
  try {
    if (resumable && !opts.full) {
      // Retomar la corrida caída desde la última página guardada (toma el bloqueo con un UPDATE atómico)
      const r = await query<{ id: number }>(
        `UPDATE customer_sync_runs SET owner = $2, status = 'running', heartbeat_at = now(), error_message = NULL, started_by = $3
          WHERE id = $1 AND (status = 'interrupted' OR (status = 'running' AND heartbeat_at < now() - ($4 || ' seconds')::interval)) RETURNING id`,
        [latest.id, owner, opts.userId, stale]
      );
      if (!r.rowCount) return busy();
      await writeLog("sync", `Sincronización de clientes RETOMADA (${modeLabel(latest.mode)}) por ${opts.userName} desde la página ${latest.next_page}`, {
        userId: opts.userId,
        detail: { run_id: latest.id },
      });
      void runLoop(latest.id, owner);
      return { ok: true, runId: latest.id, resumed: true, mode: latest.mode };
    }
    if (resumable) {
      // Recarga completa pedida: la corrida caída se descarta
      await query(`UPDATE customer_sync_runs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('interrupted','running')`, [latest.id]);
    }
    const lastDone = (
      await query<{ since: string }>(
        `SELECT ((started_at AT TIME ZONE 'America/Bogota')::date - 1)::text AS since FROM customer_sync_runs WHERE status = 'done' ORDER BY id DESC LIMIT 1`
      )
    ).rows[0];
    const mode: "full" | "incremental" = opts.full || !lastDone ? "full" : "incremental";
    const ins = await query<{ id: number }>(
      `INSERT INTO customer_sync_runs (mode, phase, since, started_by, owner) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [mode, mode === "full" ? "main" : "updated", mode === "incremental" ? lastDone!.since : null, opts.userId, owner]
    );
    const id = ins.rows[0].id;
    await writeLog("sync", `Sincronización de clientes INICIADA (${modeLabel(mode)}) por ${opts.userName}`, {
      userId: opts.userId,
      detail: { run_id: id, desde: mode === "incremental" ? lastDone!.since : null },
    });
    void runLoop(id, owner);
    return { ok: true, runId: id, resumed: false, mode };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return busy(); // el índice único: otra corrida ganó el bloqueo
    throw e;
  }
}

export type SyncStatus = {
  run: RunRow | null;
  /** corrida 'running' con el latido viejo: el proceso murió y se puede retomar */
  interrupted: boolean;
  lastDone: RunRow | null;
  recent: RunRow[];
  totals: { inPos: number; fromSiigo: number; inactive: number };
};

export async function getSyncStatus(): Promise<SyncStatus> {
  const stale = String(staleSeconds());
  const [recent, totals] = await Promise.all([
    query<RunRow>(`SELECT ${RUN_COLS} FROM customer_sync_runs ORDER BY id DESC LIMIT 6`, [stale]),
    query<{ in_pos: number; from_siigo: number; inactive: number }>(
      `SELECT count(*)::int AS in_pos, count(*) FILTER (WHERE siigo_id IS NOT NULL)::int AS from_siigo, count(*) FILTER (WHERE NOT active)::int AS inactive FROM customers`
    ),
  ]);
  const run = recent.rows[0] ?? null;
  const lastDone = recent.rows.find((r) => r.status === "done") ?? (await query<RunRow>(`SELECT ${RUN_COLS} FROM customer_sync_runs WHERE status = 'done' ORDER BY id DESC LIMIT 1`, [stale])).rows[0] ?? null;
  return {
    run,
    interrupted: !!run && (run.status === "interrupted" || (run.status === "running" && !!run.stale)),
    lastDone,
    recent: recent.rows,
    totals: { inPos: totals.rows[0].in_pos, fromSiigo: totals.rows[0].from_siigo, inactive: totals.rows[0].inactive },
  };
}

// ---------------------------------------------------------------------------
// Búsqueda en vivo: una cédula exacta que no está en la copia local se consulta en Siigo (GET por identification)
// ---------------------------------------------------------------------------
const mask = (id: string) => `***${id.slice(-3)}`;

export type LiveResult =
  | { found: PickerRow; reason?: undefined }
  | { found: null; reason: "no_existe" | "inactivo" | "no_valido" | "siigo_error" };

export async function liveLookupCustomer(identification: string, user: { uid: number; name: string }): Promise<LiveResult> {
  const id = identification.trim();
  const log = (msg: string, level: "info" | "warn" = "info") => writeLog("sync", `Búsqueda en vivo en Siigo (${mask(id)}): ${msg}`, { level, userId: user.uid });
  if (!ID_RE.test(id) || id === CONSUMIDOR_FINAL_ID) return { found: null, reason: "no_valido" };
  try {
    const data = await siigo<SiigoPage>("GET", `/v1/customers?identification=${encodeURIComponent(id)}&type=Customer`);
    const list = (Array.isArray(data.results) ? data.results : []) as { branch_office?: number }[];
    // Con varias sucursales se usa la principal (branch_office 0), igual que la sincronización
    const pick = list.find((x) => (x.branch_office ?? 0) === 0) ?? list[0];
    if (!pick) {
      await log("no existe como cliente");
      return { found: null, reason: "no_existe" };
    }
    const m = mapSiigoCustomer(pick);
    if (!m.ok) {
      await log(`encontrada pero no se puede usar (${m.reason})`, "warn");
      return { found: null, reason: "no_valido" };
    }
    await applyBatch([m.value]);
    if (!m.value.active) {
      await log("encontrada, pero está inactiva en Siigo");
      return { found: null, reason: "inactivo" };
    }
    const row = (await query<PickerRow>(`SELECT ${PICKER_COLUMNS} FROM customers WHERE identification = $1 AND active`, [m.value.identification])).rows[0];
    await log("encontrada y guardada");
    return row ? { found: row } : { found: null, reason: "no_existe" };
  } catch (e) {
    await log(`Siigo no respondió (${e instanceof Error ? e.message.slice(0, 120) : "error"})`, "warn");
    return { found: null, reason: "siigo_error" };
  }
}
