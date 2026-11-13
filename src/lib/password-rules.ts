// Largo mínimo de contraseña por rol (código puro: lo usan el servidor, la pantalla de usuarios y db/seed.mjs replica la regla).
// Administrador: 12 caracteres. Cajero y cliente: 8 (sin cambios).
export const ADMIN_MIN_PASSWORD = 12;
export const DEFAULT_MIN_PASSWORD = 8;

export const minPasswordLength = (role: string) => (role === "admin" ? ADMIN_MIN_PASSWORD : DEFAULT_MIN_PASSWORD);

/** Mensaje de error, o null si la contraseña cumple el mínimo del rol. */
export function passwordError(role: string, password: unknown): string | null {
  const min = minPasswordLength(role);
  if (typeof password !== "string" || password.length < min) {
    return role === "admin"
      ? `La contraseña de un administrador debe tener al menos ${min} caracteres`
      : `La contraseña debe tener al menos ${min} caracteres`;
  }
  return null;
}
