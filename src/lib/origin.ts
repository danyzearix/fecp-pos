/**
 * Dirección con la que el NAVEGADOR abrió la app (p. ej. http://127.0.0.1:3000).
 * OJO: new URL(req.url) no sirve: con `npm start` Next arma esa URL con el host del servidor ("localhost"), aunque la
 * pantalla esté abierta en 127.0.0.1. Se usa el encabezado Origin (lo manda el navegador en los POST) y, si no viene, Host.
 * Solo define a dónde vuelve el cliente tras pagar; el pago se verifica igual con ePayco.
 */
export function browserOrigin(req: Request): string {
  const tryOrigin = (v: string | null) => {
    if (!v) return null;
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const fromOrigin = tryOrigin(req.headers.get("origin"));
  if (fromOrigin) return fromOrigin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return (host && tryOrigin(`${proto}://${host}`)) || new URL(req.url).origin;
}
