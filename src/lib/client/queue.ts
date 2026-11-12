// Cola de ventas en localStorage. Toda venta se guarda aquí ANTES de enviarse al servidor
// y solo se quita cuando el servidor confirmó que la registró.
import type { SaleIn } from "../sale-types";

export const QUEUE_KEY = "fecp_sales_queue_v1";

export type QueuedSale = {
  sale: SaleIn;
  cashierName: string;
  queuedAt: number;
  state: "pendiente" | "error"; // 'error' = el servidor la rechazó; no se reintenta sola
  error?: string;
};

export type SendResult =
  | { kind: "ok"; status: string; invoiceName: string | null }
  | { kind: "retry" } // sin conexión, timeout o error 5xx: se reintenta luego
  | { kind: "auth" } // sesión vencida: se reintenta cuando el usuario vuelva a entrar
  | { kind: "rejected"; error: string };

export function getQueue(): QueuedSale[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedSale[]) : [];
  } catch {
    return [];
  }
}

function save(q: QueuedSale[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* sin almacenamiento: la venta igual se intenta enviar */
  }
}

export const pendingCount = () => getQueue().length;

export function enqueue(item: QueuedSale) {
  save([...getQueue().filter((x) => x.sale.id !== item.sale.id), item]);
}

export function removeFromQueue(id: string) {
  save(getQueue().filter((x) => x.sale.id !== id));
}

export function markError(id: string, error: string) {
  save(getQueue().map((x) => (x.sale.id === id ? { ...x, state: "error" as const, error } : x)));
}

/** Envía una venta. Es seguro repetirlo: el servidor ignora el UUID que ya recibió. */
export async function sendSale(sale: SaleIn): Promise<SendResult> {
  try {
    const res = await fetch("/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sale),
      signal: AbortSignal.timeout(150_000), // incluye la facturación en Siigo (hasta 120 s)
    });
    if (res.status === 401) return { kind: "auth" };
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { kind: "ok", status: String(data.status ?? "pending"), invoiceName: data.invoice_name ?? null };
    if (res.status >= 500) return { kind: "retry" };
    return { kind: "rejected", error: String(data.error ?? `Error ${res.status}`) };
  } catch {
    return { kind: "retry" };
  }
}

let flushing = false;

/** Envía las ventas pendientes en orden de creación. Se detiene en el primer fallo de red. */
export async function flushQueue(
  onSent?: (q: QueuedSale, r: Extract<SendResult, { kind: "ok" }>) => void,
  onRejected?: (q: QueuedSale, error: string) => void
) {
  if (flushing) return;
  flushing = true;
  try {
    const items = getQueue()
      .filter((x) => x.state === "pendiente")
      .sort((a, b) => a.queuedAt - b.queuedAt);
    for (const q of items) {
      const r = await sendSale(q.sale);
      if (r.kind === "ok") {
        removeFromQueue(q.sale.id);
        onSent?.(q, r);
      } else if (r.kind === "rejected") {
        markError(q.sale.id, r.error);
        onRejected?.(q, r.error);
      } else {
        break; // sin conexión o sesión vencida: respetar el orden y reintentar después
      }
    }
  } finally {
    flushing = false;
  }
}

/** Número local por caja: C01-000123. El contador vive en localStorage. */
export function nextLocalNumber(prefix: string): string {
  const key = `fecp_counter_${prefix}`;
  let n = 0;
  try {
    n = Number(localStorage.getItem(key)) || 0;
    localStorage.setItem(key, String(n + 1));
  } catch {
    n = Date.now() % 1_000_000; // sin almacenamiento: número único igualmente
  }
  return `${prefix}-${String(n + 1).padStart(6, "0")}`;
}
