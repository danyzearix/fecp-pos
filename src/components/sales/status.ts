// Etiquetas y colores de los estados de una venta (historial y configuración).
export const STATUS_INFO: Record<string, { label: string; cls: string }> = {
  pending: { label: "Pendiente", cls: "bg-warn-soft text-warn-ink" },
  invoicing: { label: "Facturando…", cls: "bg-brand-soft text-brand-ink" },
  invoiced: { label: "Facturada", cls: "bg-ok-soft text-ok-ink" },
  failed: { label: "Fallida", cls: "bg-err-soft text-err-ink" },
  revisar: { label: "Por revisar", cls: "bg-review-soft text-review-ink" },
  anulada: { label: "Anulada", cls: "bg-off-soft text-off-ink" },
  // Autoservicio (pago electrónico)
  esperando_pago: { label: "Esperando pago", cls: "bg-wait-soft text-wait-ink" },
  pagado: { label: "Pagado", cls: "bg-paid-soft text-paid-ink" },
  pago_fallido: { label: "Pago fallido", cls: "bg-err-soft text-err-ink" },
  pago_por_revisar: { label: "Pago por revisar", cls: "bg-review-soft text-review-ink" },
  pago_tardio: { label: "Pago tardío", cls: "bg-late-soft text-late-ink" },
};
export const statusInfo = (s: string) => STATUS_INFO[s] ?? { label: s, cls: "bg-off-soft text-off-ink" };
