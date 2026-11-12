// En Next.js 16 "middleware.ts" se renombró a "proxy.ts".
// Primera capa de permisos (rutas). Solo valida el JWT; los permisos salen de src/lib/permissions.ts.
// La comprobación "¿sigue activo el usuario?" y la segunda capa la hacen getCurrentUser()/guardApi() en cada endpoint.
// Los accesos bloqueados a un usuario con sesión se registran (tipo 'seguridad') llamando a un endpoint interno,
// así el proxy no necesita conectarse a la base de datos.
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { canCallApi, canOpenPage, homeFor, isPublicApi, isPublicPage } from "@/lib/permissions";
import { SECURITY_LOG_PATH, SECURITY_TOKEN_HEADER, securityToken } from "@/lib/security-token";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "@/lib/session";

function reportBlock(req: NextRequest, event: NextFetchEvent, s: SessionPayload) {
  event.waitUntil(
    (async () => {
      const token = await securityToken();
      if (!token) return;
      await fetch(new URL(SECURITY_LOG_PATH, req.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", [SECURITY_TOKEN_HEADER]: token },
        body: JSON.stringify({ userId: s.uid, role: s.role, method: req.method, path: req.nextUrl.pathname }),
      });
    })().catch(() => {})
  );
}

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login" || (isApi && isPublicApi(req.method, pathname)) || (!isApi && isPublicPage(pathname))) {
    if (session && pathname === "/login") return NextResponse.redirect(new URL(homeFor(session.role), req.url));
    return NextResponse.next();
  }

  if (!session) {
    if (isApi) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isApi) {
    if (!canCallApi(session.role, req.method, pathname)) {
      reportBlock(req, event, session);
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    return NextResponse.next();
  }

  // "/" lo resuelve la página de inicio según el rol
  if (pathname !== "/" && !canOpenPage(session.role, pathname)) {
    reportBlock(req, event, session);
    return NextResponse.redirect(new URL(homeFor(session.role), req.url));
  }
  return NextResponse.next();
}

export const config = {
  // Todo excepto archivos estáticos de Next, el favicon y los archivos de /public (cualquier ruta con extensión,
  // ej. /logo.webp): el login los necesita ANTES de que exista la sesión. Las rutas de la app y de la API no llevan punto.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
