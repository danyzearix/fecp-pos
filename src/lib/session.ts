// Solo JWT (jose). Sin base de datos ni bcrypt: lo usa también proxy.ts.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "fecp_session";
export const SESSION_HOURS = 12;

import { isRole, type Role } from "./permissions";

export type { Role };
export type SessionPayload = { uid: number; name: string; role: Role };

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET falta o es muy corto (mín. 32)");
  return new TextEncoder().encode(s);
}

export async function signSession(p: SessionPayload) {
  return new SignJWT({ ...p })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
}

export async function verifySession(token?: string): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (typeof payload.uid !== "number" || !isRole(payload.role)) return null;
    return { uid: payload.uid, name: String(payload.name), role: payload.role as Role };
  } catch {
    return null;
  }
}
