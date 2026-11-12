// Catálogo en el navegador: se guarda en localStorage (sin imágenes) para buscar sin conexión.

export type Product = {
  id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  price: number;
  tax_rate: number;
  prices_include_tax: boolean;
  image_url?: string | null;
  category: string | null;
};

const KEY = "fecp_catalog_v1";

/** minúsculas y sin tildes: "Café" → "cafe" */
export const normalize = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function loadLocalCatalog(): Product[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Product[]) : [];
  } catch {
    return [];
  }
}

export function saveLocalCatalog(products: Product[]) {
  try {
    const light = products.map((p) => ({ ...p, image_url: undefined }));
    localStorage.setItem(KEY, JSON.stringify(light));
  } catch {
    /* almacenamiento lleno o bloqueado: se sigue con el catálogo en memoria */
  }
}

/** Cuándo se verificó por última vez el catálogo contra el servidor, y qué versión tiene guardada. */
export type CatalogMeta = { updatedAt: number; version: string };
const META_KEY = "fecp_catalog_meta_v1";

export function loadCatalogMeta(): CatalogMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as CatalogMeta) : null;
  } catch {
    return null;
  }
}

export function saveCatalogMeta(meta: CatalogMeta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {}
}

/** Descarga el catálogo. Lanza error si no hay conexión. */
export async function fetchCatalog(): Promise<{ products: Product[]; version: string }> {
  const res = await fetch("/api/products", { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Sesión vencida");
  }
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return (await res.json()) as { products: Product[]; version: string };
}

/** Pide al servidor una sincronización incremental. Devuelve la versión actual del catálogo, o null si falló. */
export async function requestIncrementalSync(): Promise<string | null> {
  try {
    const res = await fetch("/api/sync/products/incremental", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export type IndexedProduct = Product & { _n: string };

export type CatalogIndex = {
  items: IndexedProduct[];
  byCode: Map<string, IndexedProduct>;
};

/** Prepara el texto normalizado de búsqueda y un mapa código → producto (barcode o sku). */
export function buildIndex(products: Product[]): CatalogIndex {
  const items = products.map((p) => ({
    ...p,
    _n: normalize(`${p.name} ${p.sku ?? ""} ${p.barcode ?? ""}`),
  }));
  const byCode = new Map<string, IndexedProduct>();
  for (const p of items) {
    if (p.barcode) byCode.set(normalize(p.barcode), p);
  }
  for (const p of items) {
    if (p.sku) {
      const k = normalize(p.sku);
      if (!byCode.has(k)) byCode.set(k, p);
    }
  }
  return { items, byCode };
}

export function searchItems(items: IndexedProduct[], q: string, category: string | null) {
  const tokens = normalize(q).split(/\s+/).filter(Boolean);
  return items.filter(
    (p) =>
      (!category || p.category === category) && tokens.every((t) => p._n.includes(t))
  );
}
