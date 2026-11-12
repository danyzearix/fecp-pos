/**
 * ¿El equipo se maneja con mouse (puntero fino) o con los dedos (puntero grueso)?
 * Se usa para NO enfocar campos al abrir una pantalla en tablet/celular: el teclado en pantalla
 * aparecería solo y taparía media interfaz. Con mouse sí conviene enfocar.
 */
export function finePointer(): boolean {
  try {
    return window.matchMedia("(pointer: fine)").matches;
  } catch {
    return true; // si no se puede saber, se comporta como un equipo con mouse
  }
}
