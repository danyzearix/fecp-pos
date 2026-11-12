import type { PosConfig } from "./sale-types";

/** Configuración NO secreta (se puede enviar al navegador). Nunca incluir claves aquí. */
export function getPosConfig(): PosConfig {
  const e = process.env;
  return {
    prefix: e.NEXT_PUBLIC_CAJA_PREFIX || "C01",
    uvt: Number(e.UVT_VALUE) || 52374,
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
    resolucion: {
      numero: e.RESOLUCION_DIAN_NUMERO ?? "",
      fecha: e.RESOLUCION_DIAN_FECHA ?? "",
      rango: e.RESOLUCION_DIAN_RANGO ?? "",
      vigencia: e.RESOLUCION_DIAN_VIGENCIA ?? "",
    },
  };
}
