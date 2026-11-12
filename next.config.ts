import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
