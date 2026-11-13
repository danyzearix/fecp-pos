import type { NextConfig } from "next";

/**
 * Encabezados de seguridad para TODAS las respuestas (páginas, API e imágenes).
 * - No es una CSP estricta (todavía): solo `frame-ancestors`, que decide quién puede mostrar el POS dentro de un iframe.
 *   Se permite el propio sitio y los dominios de ePayco/Davipay: con el checkout "onpage" ePayco abre SU iframe encima de
 *   nuestra página, y al terminar puede devolver al cliente a nuestra URL de respuesta desde ese iframe. Bloquear a ePayco
 *   ahí rompería el regreso. Cualquier otro sitio queda bloqueado (anti-clickjacking).
 *   (No se usa X-Frame-Options: no admite lista de dominios y, junto a frame-ancestors, los navegadores lo ignoran.)
 * - Permissions-Policy: la cámara SOLO para el propio sitio (foto del comprobante); micrófono y ubicación, para nadie.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.epayco.co https://*.epayco.io https://*.davipay.com" },
];

const nextConfig: NextConfig = {
  // Solo en la imagen de Docker (BUILD_STANDALONE=1): genera un servidor autocontenido y mucho más liviano.
  // Con `npm run build` / `npm start` normales no cambia nada.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  // No anunciar "X-Powered-By: Next.js"
  poweredByHeader: false,
  experimental: {
    // Con proxy.ts, Next guarda en memoria el cuerpo de cada petición hasta este límite y CORTA lo que sobre (sin error).
    // El comprobante admite 10 MB de imagen + el sobre del formulario: 12 MB. El endpoint rechaza lo que pase de 10 MB.
    proxyClientMaxBodySize: "12mb",
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Se desactivan cacheComponents/partialPrefetching: un POS es 100% dinámico
  // y esa opción obliga a envolver cada dato dinámico en <Suspense>.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
