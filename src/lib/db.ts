import { Pool } from "pg";

// Un solo pool compartido (también sobrevive a recargas en desarrollo).
const g = globalThis as unknown as { __pgPool?: Pool };

export const pool: Pool =
  g.__pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") g.__pgPool = pool;

export const query = <T extends object = Record<string, unknown>>(
  text: string,
  params?: unknown[]
) => pool.query<T>(text, params);
