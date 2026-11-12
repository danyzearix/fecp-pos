// Limitador simple en memoria para los endpoints PÚBLICOS (sin sesión). Una ventana fija por clave.
// Es por proceso: suficiente para frenar abusos básicos; no reemplaza un firewall/CDN en producción.
const g = globalThis as unknown as { __rateLimit?: Map<string, { n: number; reset: number }> };

/** true = se pasó del límite (hay que responder 429). */
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const m = (g.__rateLimit ??= new Map());
  const now = Date.now();
  if (m.size > 5000) for (const [k, v] of m) if (v.reset < now) m.delete(k);
  const cur = m.get(key);
  if (!cur || cur.reset < now) {
    m.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  cur.n++;
  return cur.n > max;
}
