import type { MetadataRoute } from "next";

// /robots.txt: el POS es una herramienta interna; ningún buscador debe rastrearlo (además va X-Robots-Tag: noindex).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
