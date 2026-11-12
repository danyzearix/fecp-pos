// Cliente del checkout ONPAGE de ePayco (navegador del kiosco). Según la documentación:
//   <script src="https://checkout.epayco.co/checkout-v2.js">
//   const checkout = ePayco.checkout.configure({ sessionId, type: "onpage", test });
//   checkout.setHooks({ onCreated, onResponse, onErrors, onClosed });  checkout.open();
// ⚠ La documentación NO dice cómo se llaman los campos de lo que reciben los hooks. Por eso se busca el ref_payco
// recursivamente. Aun así, lo que el navegador reporte es solo una PISTA: el servidor lo verifica con ePayco.

type Hook = (payload: unknown) => void;
type Checkout = { setHooks?: (h: Record<string, Hook>) => void; open: () => void };
type EpaycoGlobal = { checkout: { configure: (o: { sessionId: string; type: "onpage" | "standard"; test: boolean }) => Checkout } };

const SCRIPT_URL = "https://checkout.epayco.co/checkout-v2.js";

export async function loadEpaycoScript(): Promise<EpaycoGlobal> {
  const w = window as unknown as { ePayco?: EpaycoGlobal };
  if (w.ePayco) return w.ePayco;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("No cargó el checkout de ePayco")));
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("No cargó el checkout de ePayco"));
    document.head.appendChild(s);
  });
  if (!w.ePayco) throw new Error("El checkout de ePayco no está disponible");
  return w.ePayco;
}

/** Busca un campo ref_payco / x_ref_payco / refPayco en cualquier parte del objeto. */
export function findRef(o: unknown, depth = 0): string | null {
  if (!o || typeof o !== "object" || depth > 5) return null;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (/^(x_)?ref_?payco$/i.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
  }
  for (const v of Object.values(o as Record<string, unknown>)) {
    const r = findRef(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Nombres de campos (sin valores) hasta 3 niveles, para el diagnóstico */
export function shapeOf(o: unknown, prefix = "", depth = 0): string[] {
  if (!o || typeof o !== "object" || depth > 3) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    out.push(...shapeOf(v, p, depth + 1));
  }
  return out;
}

export type EpaycoHandlers = {
  onPayload: (hook: "onCreated" | "onResponse" | "onErrors" | "onClosed", payload: unknown) => void;
};

/** Abre el checkout en la propia pantalla. Devuelve una función para volver a abrirlo. */
export async function openOnpageCheckout(sessionId: string, test: boolean, h: EpaycoHandlers): Promise<() => void> {
  const epayco = await loadEpaycoScript();
  const checkout = epayco.checkout.configure({ sessionId, type: "onpage", test });
  if (typeof checkout.setHooks === "function") {
    checkout.setHooks({
      onCreated: (p) => h.onPayload("onCreated", p),
      onResponse: (p) => h.onPayload("onResponse", p),
      onErrors: (p) => h.onPayload("onErrors", p),
      onClosed: (p) => h.onPayload("onClosed", p),
    });
  }
  checkout.open();
  return () => checkout.open();
}
