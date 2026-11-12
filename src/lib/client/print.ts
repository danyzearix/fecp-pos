// Imprime /ticket/[id] en un iframe oculto (sin abrir ventanas, no lo bloquea el navegador).
// La página de la tirilla llama a window.print() sola y avisa con postMessage al terminar.
export function printTicket(saleId: string) {
  const iframe = document.createElement("iframe");
  iframe.src = `/ticket/${saleId}`;
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";

  const cleanup = () => {
    window.removeEventListener("message", onMsg);
    clearTimeout(timer);
    iframe.remove();
  };
  const onMsg = (e: MessageEvent) => {
    if (e.origin === location.origin && e.data?.type === "ticket-printed" && e.data.id === saleId) cleanup();
  };
  const timer = setTimeout(cleanup, 120_000);
  window.addEventListener("message", onMsg);
  document.body.appendChild(iframe);
}
