import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Solo en la imagen de Docker (BUILD_STANDALONE=1): genera un servidor autocontenido y mucho más liviano.
  // Con `npm run build` / `npm start` normales no cambia nada.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
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
