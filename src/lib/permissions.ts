// ÚNICO lugar donde se definen los permisos por rol. Lo usan, sin repetir lógica:
//   1) src/proxy.ts            → rutas (páginas) y endpoints
//   2) cada endpoint de la API → guardApi() en src/lib/auth.ts (no se confía solo en el proxy)
//   3) la barra lateral        → canOpenPage() para mostrar solo lo que el rol puede abrir
// Código puro (sin base de datos): se puede importar desde el navegador y desde el proxy.

export type Role = "admin" | "cajero" | "cliente";
export const ROLES: Role[] = ["admin", "cajero", "cliente"];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrador",
  cajero: "Cajero",
  cliente: "Cliente (autoservicio)",
};

// ---------------------------------------------------------------------------
// PÁGINAS: rol → prefijos de ruta que puede abrir
// ---------------------------------------------------------------------------
export const PAGES_BY_ROLE: Record<Role, string[]> = {
  admin: ["/caja", "/ventas", "/ticket", "/admin"],
  cajero: ["/caja", "/ventas", "/ticket"],
  // Autoservicio (5B): el rol cliente SOLO puede abrir /kiosco. Nada más.
  cliente: ["/kiosco"],
};

/** Pantalla de inicio de cada rol */
export const HOME_BY_ROLE: Record<Role, string> = {
  admin: "/caja",
  cajero: "/caja",
  cliente: "/kiosco",
};

// ---------------------------------------------------------------------------
// ENDPOINTS: rol → [métodos, patrón de ruta] que puede llamar
// ---------------------------------------------------------------------------
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Methods = "*" | Method | Method[];
export type ApiRule = [Methods, RegExp];

const UUID = "[0-9a-fA-F-]{36}";

/** Lo que usa la caja: catálogo, clientes, ventas, tirillas y sincronización incremental */
const CAJA_API: ApiRule[] = [
  ["GET", /^\/api\/products$/],
  ["GET", /^\/api\/customers$/],
  ["GET", /^\/api\/sales$/], // historial (el cajero solo recibe las suyas del día: se filtra en el endpoint)
  ["POST", /^\/api\/sales$/],
  ["GET", new RegExp(`^/api/sales/${UUID}$`)], // datos de tirilla (reimprimir)
  ["POST", /^\/api\/sync\/products\/incremental$/],
];

/**
 * Cobro electrónico (ePayco) desde la caja: usa los mismos endpoints del kiosco. Cada endpoint decide por el ROL qué
 * ventas puede tocar (cliente → las del kiosco; cajero/admin → las de la caja) y solo las suyas (cashier_id).
 */
const CAJA_EPAYCO_API: ApiRule[] = [
  ["POST", /^\/api\/kiosco\/pagos$/],
  ["GET", new RegExp(`^/api/kiosco/pagos/${UUID}$`)],
  ["POST", new RegExp(`^/api/kiosco/pagos/${UUID}/confirmar$`)],
  ["POST", new RegExp(`^/api/kiosco/pagos/${UUID}/hooks$`)],
];

export const API_BY_ROLE: Record<Role, ApiRule[]> = {
  admin: [
    ...CAJA_API,
    ...CAJA_EPAYCO_API,
    ["POST", new RegExp(`^/api/sales/${UUID}/retry$`)], // reintentar / verificar facturación: solo admin
    ["POST", /^\/api\/sync\/products$/], // sincronización completa
    ["*", /^\/api\/admin(\/|$)/], // usuarios, logs, reportes, configuración, catálogos de Siigo
  ],
  cajero: [...CAJA_API, ...CAJA_EPAYCO_API],
  // Autoservicio (5B): catálogo, latido de conexión, cobro (crear, estado, confirmar, tirilla) y salida del admin.
  cliente: [
    ["GET", /^\/api\/kiosco\/catalogo$/],
    ["GET", /^\/api\/kiosco\/ping$/],
    ["POST", /^\/api\/kiosco\/salir$/],
    ["GET", new RegExp(`^/api/kiosco/pagos/${UUID}/ticket$`)],
    ["POST", new RegExp(`^/api/kiosco/pagos/${UUID}/hooks$`)],
    ["POST", /^\/api\/kiosco\/pagos$/],
    ["GET", new RegExp(`^/api/kiosco/pagos/${UUID}$`)],
    ["POST", new RegExp(`^/api/kiosco/pagos/${UUID}/confirmar$`)],
  ],
};

/** Endpoints sin sesión o válidos para cualquier usuario autenticado */
// /api/internal/security-log: lo llama el proxy; el endpoint exige un token interno (src/lib/security-token.ts)
export const API_PUBLIC: ApiRule[] = [
  ["POST", /^\/api\/auth\/login$/],
  ["POST", /^\/api\/internal\/security-log$/],
  // Webhook de ePayco: lo llama ePayco sin sesión. Está APAGADO (404) mientras APP_PUBLIC_URL esté vacío y exige firma válida.
  [["GET", "POST"], /^\/api\/epayco\/confirmacion$/],
  // Pago desde el celular con el enlace /pagar/<código> (48 hex aleatorios). Sin sesión: el endpoint valida el código,
  // limita los intentos y SIEMPRE verifica el pago con ePayco (nunca confía en el navegador).
  ["GET", /^\/api\/pagar\/[0-9a-f]{48}$/],
  ["POST", /^\/api\/pagar\/[0-9a-f]{48}\/(sesion|confirmar)$/],
];

/** Páginas públicas (sin sesión): el enlace de pago y la página a la que ePayco devuelve al cliente. */
export const PUBLIC_PAGES: RegExp[] = [/^\/pagar\/[0-9a-f]{48}(\/respuesta)?$/];
export const isPublicPage = (path: string) => PUBLIC_PAGES.some((re) => re.test(path));
export const API_ANY_AUTHENTICATED: ApiRule[] = [["POST", /^\/api\/auth\/logout$/]];

// ---------------------------------------------------------------------------
// Funciones de consulta
// ---------------------------------------------------------------------------
const starts = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

export function canOpenPage(role: Role, path: string): boolean {
  return PAGES_BY_ROLE[role]?.some((p) => starts(path, p)) ?? false;
}

const matches = (rules: ApiRule[], method: string, path: string) =>
  rules.some(([m, re]) => (m === "*" || m === method || (Array.isArray(m) && m.includes(method as Method))) && re.test(path));

export const isPublicApi = (method: string, path: string) => matches(API_PUBLIC, method, path);

export function canCallApi(role: Role, method: string, path: string): boolean {
  return matches(API_ANY_AUTHENTICATED, method, path) || matches(API_BY_ROLE[role] ?? [], method, path);
}

export const homeFor = (role: Role) => HOME_BY_ROLE[role] ?? "/login";

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as string[]).includes(v);
