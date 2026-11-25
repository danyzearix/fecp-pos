// Textos LEGALES fijos de la tirilla de venta (los pide la DIAN / el modelo de Siigo POS). Los datos que cambian (régimen, actividad
// económica, resolución, fabricante del software) NO están aquí: vienen de variables de entorno (src/lib/config.ts, TICKET_*,
// RESOLUCION_DIAN_*) o de Siigo.

/** Aviso de título valor (Ley 1231 de 2008, art. 5) */
export const LETRA_DE_CAMBIO =
  "A esta factura de venta aplican las normas relativas a la letra de cambio (artículo 5 Ley 1231 de 2008). " +
  "Con esta el Comprador declara haber recibido real y materialmente las mercancías o prestación de servicios descritos en este título - Valor.";

/** Ruta del logo para la tirilla (blanco y negro, ~30 mm de ancho). Si el archivo no existe, la tirilla se imprime sin logo. */
export const TICKET_LOGO_SRC = "/logo-fecp.png";
export const TICKET_LOGO_WIDTH_MM = 30;
