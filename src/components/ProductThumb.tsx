// Imagen de un producto, o un MARCADOR neutro con las iniciales cuando no hay foto (los productos de Siigo no tienen imágenes).
// Mismo tamaño que las fotos (lo da el contenedor) y colores de los tokens (claro y oscuro).
export const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return two.toUpperCase();
};

export default function ProductThumb({ name, src, textClass }: { name: string; src?: string | null; textClass: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
  ) : (
    <span aria-hidden className={`${textClass} font-bold text-dim select-none`} data-placeholder="1">
      {initials(name)}
    </span>
  );
}
