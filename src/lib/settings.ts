import { query } from "./db";

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export const SETTING_LAST_SYNC = "woo_last_sync"; // inicio (ISO) de la última sincronización exitosa
export const SETTING_PRICES_INCLUDE_TAX = "woo_prices_include_tax"; // 'yes' | 'no' de la última sincronización
