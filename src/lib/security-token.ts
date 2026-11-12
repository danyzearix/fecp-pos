// Token interno para que el proxy avise al servidor de un acceso bloqueado.
// Se deriva de SESSION_SECRET con SHA-256 (Web Crypto: funciona en el proxy). Nunca sale del servidor.
export const SECURITY_LOG_PATH = "/api/internal/security-log";
export const SECURITY_TOKEN_HEADER = "x-security-token";

export async function securityToken(): Promise<string | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:security-log`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
