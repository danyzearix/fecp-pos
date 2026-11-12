// ÚNICO lugar donde se definen los estados de una venta y sus transiciones permitidas.
// Toda transición de estado del flujo de pago pasa por transitionSale(): un UPDATE atómico con
// "WHERE status = ANY(desde)", así dos procesos a la vez no pueden pasar la misma venta dos veces.
import { query } from "./db";

export const SALE_STATUSES = [
  // Caja y facturación (etapas 1–5A)
  "pending", // registrada, aún no facturada
  "invoicing", // facturando en Siigo ahora mismo
  "invoiced", // facturada
  "failed", // Siigo la rechazó o falló (se puede reintentar)
  "revisar", // no se sabe si Siigo la creó: solo se VERIFICA, nunca se reintenta a ciegas
  "anulada", // cancelada a mano, nunca se factura
  // Autoservicio con pago electrónico (etapa 5B)
  "esperando_pago", // cobro creado en ePayco, sin pago confirmado todavía
  "pagado", // pago verificado por el servidor; listo para facturar
  "pago_fallido", // rechazado, vencido o no se pudo crear el cobro. NO se factura
  "pago_por_revisar", // la verificación falló o no coincide algo: un admin decide. NO se factura
  "pago_tardio", // se aprobó DESPUÉS de vencer el cobro. NO se factura sola: un admin decide
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** Transiciones permitidas: estado actual → estados a los que puede pasar */
export const TRANSITIONS: Record<SaleStatus, SaleStatus[]> = {
  pending: ["invoicing", "anulada"],
  invoicing: ["invoiced", "failed", "revisar"],
  invoiced: [],
  failed: ["invoicing", "anulada"],
  revisar: ["invoicing", "failed", "invoiced"],
  anulada: [],
  esperando_pago: ["pagado", "pago_fallido", "pago_por_revisar", "anulada"],
  pagado: ["invoicing", "anulada"],
  pago_fallido: ["pago_tardio", "anulada"],
  pago_por_revisar: ["pagado", "pago_fallido", "anulada"], // admin: "Facturar" → pagado, o descartar
  pago_tardio: ["pagado", "anulada"], // admin: "Facturar" → pagado
};

/** Estados desde los que se puede iniciar la facturación en Siigo */
export const INVOICEABLE: SaleStatus[] = ["pending", "failed", "pagado"];

/**
 * Estados que NO cuentan en los reportes ni en "Total recaudado" / "Total facturado".
 * pago_por_revisar y pago_tardio se muestran aparte ("Pagos por revisar"): cuando un admin los resuelve con "Facturar"
 * pasan a pagado → facturada y SÍ cuentan; con "Marcar para reembolso" quedan fuera de todo.
 */
export const NOT_REVENUE: SaleStatus[] = ["anulada", "esperando_pago", "pago_fallido", "pago_por_revisar", "pago_tardio"];
export const NOT_REVENUE_SQL = NOT_REVENUE.map((s) => `'${s}'`).join(",");

export const isSaleStatus = (s: string): s is SaleStatus => (SALE_STATUSES as readonly string[]).includes(s);

export function transitionAllowed(from: SaleStatus, to: SaleStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Ejecutor de SQL: por defecto el pool; dentro de una transacción se pasa el cliente de esa transacción */
export type Exec = (text: string, params: unknown[]) => Promise<{ rowCount: number | null }>;

/**
 * Cambia el estado de forma atómica. Devuelve true si ESTA llamada hizo el cambio
 * (false = la venta ya no estaba en ninguno de los estados "desde": alguien se adelantó).
 * `set` agrega columnas al mismo UPDATE (nombres fijos del código, nunca datos del usuario).
 */
export async function transitionSale(
  saleId: string,
  from: SaleStatus[],
  to: SaleStatus,
  set: Record<string, unknown> = {},
  exec: Exec = (t, p) => query(t, p)
): Promise<boolean> {
  for (const f of from) {
    if (!transitionAllowed(f, to)) throw new Error(`Transición de venta no permitida: ${f} → ${to}`);
  }
  const cols = Object.keys(set);
  const sets = ["status = $2", ...cols.map((c, i) => `${c} = $${i + 4}`)];
  const { rowCount } = await exec(`UPDATE sales SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($3::text[])`, [
    saleId,
    to,
    from,
    ...cols.map((c) => set[c]),
  ]);
  return (rowCount ?? 0) > 0;
}
