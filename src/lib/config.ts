import type { PosConfig } from "./sale-types";

/** Configuración NO secreta (se puede enviar al navegador). Nunca incluir claves aquí. */
/**
 * Plazo ÚNICO del Crédito FECP en días (gerencia autorizó 60). Variable CREDITO_PLAZO_DIAS; si falta o no es un entero entre 1 y 365 se usa 60.
 * Cuando el plazo cambie, también cambia lo que acepta el servidor (rechaza cualquier otro).
 */
export const CREDITO_PLAZO_DIAS_DEFAULT = 60;
export function creditoPlazoDias(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.CREDITO_PLAZO_DIAS ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : CREDITO_PLAZO_DIAS_DEFAULT;
}

/**
 * ¿Se EXIGE la foto del comprobante con Transferencia? Variable REQUIRE_RECEIPT_PHOTO (por defecto false = opcional; solo "true" la exige).
 * La referencia y la casilla de verificación siguen siendo obligatorias; la foto de la TARJETA siempre fue opcional.
 */
export function requireReceiptPhoto(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REQUIRE_RECEIPT_PHOTO ?? "").trim().toLowerCase() === "true";
}

/** Textos de la tirilla que NO vienen de Siigo ni de la resolución. Variables opcionales (TICKET_*): sin ellas se usan estos valores. */
export const TICKET_DEFAULTS = {
  regimen: "Régimen Especial",
  actividad: "8559",
  proveedorSoftware: "Siigo S.A.S - Nit: 830.048.145-8",
  nombreSoftware: "Siigo Nube",
} as const;

export function getPosConfig(): PosConfig {
  const e = process.env;
  return {
    prefix: e.NEXT_PUBLIC_CAJA_PREFIX || "C01",
    uvt: Number(e.UVT_VALUE) || 52374,
    // Res. DIAN 165/2023 art. 11 num. 3.3: se puede facturar a Consumidor final sin importar el monto. false = tope de 5 UVT
    // (por encima hay que identificar al cliente). Sin la variable se asume true (lo acordado con el cliente).
    consumidorFinalSinTope: (e.CONSUMIDOR_FINAL_SIN_TOPE ?? "true").trim().toLowerCase() !== "false",
    testMode: e.SIIGO_TEST_MODE === "true",
    defaultStateCode: e.POS_STATE_CODE || "11",
    defaultCityCode: e.POS_CITY_CODE || "11001",
    negocio: {
      nombre: e.NEGOCIO_NOMBRE ?? "",
      nit: e.NEGOCIO_NIT ?? "",
      direccion: e.NEGOCIO_DIRECCION ?? "",
      telefono: e.NEGOCIO_TELEFONO ?? "",
    },
    software: {
      nombre: e.SOFTWARE_NOMBRE || "FECP POS",
      fabricante: e.SOFTWARE_FABRICANTE || "Atria Digital",
    },
    tirilla: {
      regimen: e.TICKET_REGIMEN?.trim() || TICKET_DEFAULTS.regimen,
      actividad: e.TICKET_ACTIVIDAD_ECONOMICA?.trim() || TICKET_DEFAULTS.actividad,
      proveedorSoftware: e.TICKET_PROVEEDOR_SOFTWARE?.trim() || TICKET_DEFAULTS.proveedorSoftware,
      nombreSoftware: e.TICKET_NOMBRE_SOFTWARE?.trim() || TICKET_DEFAULTS.nombreSoftware,
    },
    requireReceiptPhoto: requireReceiptPhoto(e),
    creditoPlazoDias: creditoPlazoDias(e),
    resolucion: {
      numero: e.RESOLUCION_DIAN_NUMERO ?? "",
      fecha: e.RESOLUCION_DIAN_FECHA ?? "",
      rango: e.RESOLUCION_DIAN_RANGO ?? "",
      vigencia: e.RESOLUCION_DIAN_VIGENCIA ?? "",
    },
  };
}
