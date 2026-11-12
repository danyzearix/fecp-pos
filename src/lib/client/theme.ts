// Tema claro/oscuro. La preferencia es POR DISPOSITIVO (localStorage), no por usuario ni por servidor.
// Sin preferencia guardada → tema CLARO (no se mira el tema del sistema operativo).
export const THEME_KEY = "fecp_theme_v1";
export type Theme = "light" | "dark";

/**
 * Script que corre ANTES del primer pintado (va en <head>): pone la clase .dark en <html> si corresponde,
 * así no hay parpadeo blanco→negro al cargar. Si localStorage no está disponible, se queda en claro.
 */
export const THEME_SCRIPT = `(function(){try{if(localStorage.getItem("${THEME_KEY}")==="dark")document.documentElement.classList.add("dark")}catch(e){}})()`;

export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Aplica el tema al documento y lo guarda para este dispositivo. */
export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* sin almacenamiento: el tema dura lo que la pestaña */
  }
}
