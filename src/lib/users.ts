/** siigo_seller_id: número entero positivo, o null/"" para usar el SIIGO_SELLER_ID del .env. undefined = inválido o ausente. */
export function parseSellerId(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
