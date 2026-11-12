// Puntos de PRUEBA: permiten apuntar ePayco y Siigo a un servidor simulado en pruebas automáticas.
// SOLO tienen efecto con NODE_ENV = 'test' o 'development'. En producción (npm run build + npm start) se IGNORAN
// y se usan siempre las URLs oficiales, para que nadie pueda desviar credenciales a otro servidor.
// (Sin imports a propósito: así se puede verificar con un script de Node.)
export const testHooksEnabled = (): boolean => process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development";

export function testOverride(name: string, officialValue: string): string {
  if (!testHooksEnabled()) return officialValue;
  const v = (process.env[name] ?? "").trim();
  return v || officialValue;
}
