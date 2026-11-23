"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import FullscreenButton from "@/components/FullscreenButton";
import Logo from "@/components/Logo";
import TicketView, { dianQrUrl } from "@/components/ticket/TicketView";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useFullscreen } from "@/hooks/useFullscreen";
import { buildIndex, normalize, searchItems, type IndexedProduct, type Product } from "@/lib/client/catalog";
import { buildCustomerFromForm, EMAIL_RE, emptyCustomerForm, validateCustomerForm } from "@/lib/client/customer-form";
import { beepError, beepOk } from "@/lib/client/sound";
import { cartTotals, formatCOP, type CartLine } from "@/lib/money";
import type { PosConfig, TicketData } from "@/lib/sale-types";
import CedulaStep, { type CedulaChoice } from "./CedulaStep";
import CustomerStep from "./CustomerStep";
import KioskPayment, { KIOSK_STORE_KEY } from "./KioskPayment";
import type { CreateResult, PayChannel, PaySale, Phase } from "@/components/epayco/useEpaycoPayment";
import ExitDialog from "./ExitDialog";

type Screen = "tienda" | "cedula" | "datos" | "pago";

const IDLE_RESET_MS = 180_000; // 3 minutos sin actividad → vacía el carrito y vuelve al inicio
const IDLE_WARN_MS = 155_000;
const MAX_CARDS = 60;
// Combinación para abrir el diálogo de salida (solo la conoce el administrador). También: 7 toques rápidos sobre el logo.
const isExitCombo = (e: KeyboardEvent) => e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === "k";

const json = { "Content-Type": "application/json" };

export default function KioscoClient({
  uvt,
  sinTope,
  qrAvailable,
  printer,
  defaultState,
  defaultCity,
}: {
  uvt: number;
  /** CONSUMIDOR_FINAL_SIN_TOPE: true = Consumidor final sin tope de monto */
  sinTope: boolean;
  /** ¿hay dominio público (APP_PUBLIC_URL)? Sin él no existe el pago con QR */
  qrAvailable: boolean;
  printer: boolean;
  defaultState: string;
  defaultCity: string;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [screen, setScreen] = useState<Screen>("tienda");
  const [form, setForm] = useState(() => emptyCustomerForm({ state: defaultState, city: defaultCity }));
  // Cliente de la compra: cf = Consumidor final · existing = "Sí, soy yo" (solo el número; el servidor lo vuelve a buscar) · new = formulario en blanco
  const [custMode, setCustMode] = useState<"cf" | "existing" | "new">("cf");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  // Pago electrónico: el estado vive en <KioskPayment> (se desmonta al salir de la pantalla y no deja nada)
  const [payPhase, setPayPhase] = useState<Phase>("choose");
  const [resume, setResume] = useState<{ sale: PaySale; ref: string | null } | null>(null);
  const abortPay = useRef<(() => void) | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [offline, setOffline] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [idleWarn, setIdleWarn] = useState(false);
  const [localTicket, setLocalTicket] = useState<{ data: TicketData; config: PosConfig; qr: string | null } | null>(null);
  const [startDismissed, setStartDismissed] = useState(false); // ya tocaron "Toque para iniciar"
  const { isFull, toggle: toggleFullscreen } = useFullscreen();
  const goFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) await toggleFullscreen();
  }, [toggleFullscreen]);

  const lastActivity = useRef(Date.now());
  const logoTaps = useRef<number[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const deferredQuery = useDeferredValue(query);
  const index = useMemo(() => buildIndex(products), [products]);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "es")), [products]);
  const filtered = useMemo(() => searchItems(index.items, deferredQuery, category), [index, deferredQuery, category]);
  const totals = useMemo(() => cartTotals(cart), [cart]);
  // Con CONSUMIDOR_FINAL_SIN_TOPE=false se conserva el tope anterior: por encima de 5 UVT (base sin IVA) no se ofrece Consumidor final
  const cfAllowed = sinTope || totals.subtotal <= 5 * uvt;
  const qtyIn = useMemo(() => new Map(cart.map((l) => [l.productId, l.qty])), [cart]);

  const showToast = useCallback((text: string, kind: "ok" | "err") => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // ---------------------------------------------------------------- catálogo
  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch("/api/kiosco/catalogo", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setProducts(((await res.json()) as { products: Product[] }).products);
      setCatalogError(false);
    } catch {
      setCatalogError(true);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCatalog();
  }, [loadCatalog]);

  // ---------------------------------------------------------------- reinicio
  const reset = useCallback(() => {
    setCart([]);
    setQuery("");
    setCategory(null);
    setForm(emptyCustomerForm({ state: defaultState, city: defaultCity }));
    setCustMode("cf");
    setFormError("");
    setBusy(false);
    setResume(null);
    try {
      localStorage.removeItem(KIOSK_STORE_KEY);
    } catch {}
    setIdleWarn(false);
    setPayPhase("choose");
    setScreen("tienda");
    loadCatalog();
  }, [defaultCity, defaultState, loadCatalog]);

  // ---------------------------------------------------------------- usar 127.0.0.1, no localhost
  // ePayco rechaza "localhost" como URL de regreso, pero acepta 127.0.0.1 (mismo equipo, mismo servidor). La cookie de
  // sesión es por dirección, así que la primera vez habrá que iniciar sesión otra vez en 127.0.0.1.
  useEffect(() => {
    if (location.hostname === "localhost") location.replace(location.href.replace("//localhost", "//127.0.0.1"));
  }, []);

  // ---------------------------------------------------------------- retomar una venta en curso
  // (al volver de ePayco con ?ref_payco=..., o si se recargó la pantalla durante el pago). La verificación la hace el servidor.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KIOSK_STORE_KEY);
      if (!raw) return;
      const sv = JSON.parse(raw) as PaySale;
      if (!sv?.id || new Date(sv.expiresAt).getTime() < Date.now() - 30 * 60_000) return void localStorage.removeItem(KIOSK_STORE_KEY);
      const q = new URLSearchParams(location.search);
      const ref = (q.get("ref_payco") || q.get("x_ref_payco") || "").trim();
      if (ref) history.replaceState(null, "", location.pathname); // limpia la URL
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResume({ sale: sv, ref: ref || null }); // el ref es solo una PISTA: el servidor la verifica con ePayco
      setScreen("pago");
    } catch {
      /* sin almacenamiento: no se puede retomar */
    }
  }, []);

  // ---------------------------------------------------------------- bloqueo del kiosco
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      lastActivity.current = Date.now();
      if (isExitCombo(e)) {
        e.preventDefault();
        setExitOpen(true);
        return;
      }
      const editing = ["c", "v", "x", "a", "z"].includes(e.key.toLowerCase());
      // F1–F12 (F5 recargar, F11 pantalla completa, F12 herramientas), Alt+flechas (atrás/adelante) y Ctrl+tecla
      // (L, T, N, W, P, S, U, J...) se bloquean. Salvo copiar/pegar dentro de un campo de texto.
      if (/^F\d{1,2}$/.test(e.key) || e.altKey || ((e.ctrlKey || e.metaKey) && !editing) || e.key === "ContextMenu") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const noMenu = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", noMenu);
    window.addEventListener("dragstart", noMenu);
    // Botón "atrás" del navegador: se queda en la misma página
    history.pushState(null, "", location.href);
    const onPop = () => history.pushState(null, "", location.href);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", noMenu);
      window.removeEventListener("dragstart", noMenu);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  const onLogoTap = () => {
    const now = Date.now();
    logoTaps.current = [...logoTaps.current.filter((t) => now - t < 5000), now];
    if (logoTaps.current.length >= 7) {
      logoTaps.current = [];
      setExitOpen(true);
    }
  };

  // ---------------------------------------------------------------- conexión
  useEffect(() => {
    let fails = 0;
    const check = async () => {
      if (!navigator.onLine) {
        setOffline(true);
        return;
      }
      try {
        const r = await fetch("/api/kiosco/ping", { cache: "no-store", signal: AbortSignal.timeout(4000) });
        if (r.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!r.ok) throw new Error();
        fails = 0;
        setOffline(false);
      } catch {
        if (++fails >= 2) setOffline(true);
      }
    };
    const onNet = () => void check();
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    const iv = setInterval(check, 5000);
    return () => {
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
      clearInterval(iv);
    };
  }, []);

  // ---------------------------------------------------------------- inactividad
  useEffect(() => {
    const touch = () => {
      lastActivity.current = Date.now();
      setIdleWarn(false);
    };
    const evs = ["pointerdown", "touchstart", "keydown", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const iv = setInterval(() => {
      // Durante un pago en marcha (QR, ventana, verificando, en proceso, facturando) no se reinicia; en la elección y en los resultados sí
      const payIdle = screen === "pago" && ["choose", "creating", "confirm_total", "in_process", "confirm_paid", "cancelled", "rejected", "expired", "paid", "paid_review", "review"].includes(payPhase);
      if (exitOpen || !(["tienda", "cedula", "datos"].includes(screen) || payIdle)) return;
      const idle = Date.now() - lastActivity.current;
      if (idle >= IDLE_RESET_MS) {
        abortPay.current?.(); // si hay una venta abierta, se cancela en el servidor
        reset();
      }
      else setIdleWarn(idle >= IDLE_WARN_MS);
    }, 1000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(iv);
    };
  }, [screen, exitOpen, payPhase, reset]);

  // ---------------------------------------------------------------- carrito
  const addProduct = useCallback(
    (p: Product) => {
      if (!p.sku) return showToast("Este producto no está disponible aquí", "err");
      beepOk();
      setCart((prev) => {
        const i = prev.findIndex((l) => l.productId === p.id);
        if (i >= 0) {
          const next = [...prev];
          next[i] = { ...next[i], qty: Math.min(99, next[i].qty + 1) };
          return next;
        }
        return [...prev, { productId: p.id, sku: p.sku, barcode: p.barcode, name: p.name, unitPrice: p.price, taxRate: p.tax_rate, includesTax: p.prices_include_tax, qty: 1 }];
      });
    },
    [showToast]
  );
  const changeQty = (id: number, d: number) =>
    setCart((prev) => prev.flatMap((l) => (l.productId !== id ? [l] : l.qty + d <= 0 ? [] : [{ ...l, qty: Math.min(99, l.qty + d) }])));

  const handleCode = useCallback(
    (raw: string) => {
      const p = index.byCode.get(normalize(raw));
      if (p) addProduct(p);
      else {
        beepError();
        showToast(`Código no encontrado: ${raw}`, "err");
      }
    },
    [index, addProduct, showToast]
  );
  useBarcodeScanner(handleCode, screen === "tienda" && !offline && !exitOpen);

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const q = query.trim();
    if (!q) return;
    const exact = index.byCode.get(normalize(q));
    if (exact) {
      addProduct(exact);
      setQuery("");
    } else if (filtered.length === 0) {
      beepError();
      showToast(`Código no encontrado: ${q}`, "err");
    }
  }

  // ---------------------------------------------------------------- resultados
  const printTicket = useCallback(async (saleId: string) => {
    try {
      const r = await fetch(`/api/kiosco/pagos/${saleId}/ticket`, { cache: "no-store" });
      if (!r.ok) return;
      const { ticket, config } = (await r.json()) as { ticket: TicketData; config: PosConfig };
      const qr = ticket.cufe ? await QRCode.toDataURL(dianQrUrl(ticket.cufe), { margin: 0, width: 240 }).catch(() => null) : null;
      setLocalTicket({ data: ticket, config, qr });
    } catch {
      /* si no se puede imprimir, la pantalla igual muestra el número de factura */
    }
  }, []);
  useEffect(() => {
    if (!localTicket) return;
    const t = setTimeout(() => window.print(), 250);
    const after = () => setLocalTicket(null);
    window.addEventListener("afterprint", after, { once: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", after);
    };
  }, [localTicket]);

  // ---------------------------------------------------------------- pago
  /** Crea la VENTA con el canal que eligió la persona. El navegador SOLO manda productos y cantidades (más el cliente): el servidor calcula precios, IVA y total. */
  const createSale = useCallback(
    async (channel: PayChannel): Promise<CreateResult> => {
      try {
        const res = await fetch("/api/kiosco/pagos", {
          method: "POST",
          headers: json,
          body: JSON.stringify({
            items: cart.map((l) => ({ product_id: l.productId, quantity: l.qty })),
            // Solo tipo y número de un cliente que ya existe: el servidor lo vuelve a buscar (nunca se manda nombre ni id de Siigo)
            checkout_type: custMode === "cf" ? "corto" : "completo",
            customer:
              custMode === "cf" ? null : custMode === "existing" ? { id_type: "13", identification: form.identification } : buildCustomerFromForm(form, "completo"),
            notify_email: form.email.trim() || undefined,
            channel,
          }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: d.error ?? "No se pudo iniciar el pago" };
        return {
          ok: true,
          sale: {
            id: d.sale_id, local: d.local_number, total: d.total, sessionId: d.session_id ?? null, expiresAt: d.expires_at, test: !!d.test,
            channel: d.channel === "qr" ? "qr" : "pantalla", qrAvailable: !!d.qr_available, payUrl: d.pay_url ?? null, attempt: 1,
          },
        };
      } catch {
        return { ok: false, error: "No se pudo conectar. Intente de nuevo." };
      }
    },
    [cart, custMode, form]
  );
  function submitCustomer() {
    const err = custMode === "new" ? validateCustomerForm(form, "completo") : form.email.trim() && !EMAIL_RE.test(form.email.trim()) ? "El correo no es válido" : null;
    if (err) return setFormError(err);
    setFormError("");
    setScreen("pago"); // primero se elige cómo pagar; la venta y la sesión de ePayco se crean DESPUÉS de elegir
  }

  // El aviso "Toque para iniciar" solo si NO está en pantalla completa y aún no lo tocaron,
  // y nunca encima de una compra en curso (si se recargó durante el pago).
  const showStart = !isFull && !startDismissed && screen === "tienda" && cart.length === 0;

  // ================================================================ pantallas

  return (
    <>
      <div className="print:hidden h-screen w-screen overflow-hidden bg-app select-none [&_input]:select-text text-fg">
        <header className="h-16 sm:h-20 bg-surface border-b border-line flex items-center gap-3 sm:gap-5 px-3 sm:px-6">
          <button onClick={onLogoTap} aria-label="FECP" className="outline-none min-h-11 flex items-center">
            <Logo className="h-10 w-16 sm:h-14 sm:w-24" />
          </button>
          <div>
            <div className="text-lg sm:text-2xl font-bold">Autoservicio</div>
            <div className="text-[13px] sm:text-[15px] text-soft">Escanee el código de barras o toque un producto</div>
          </div>
          {/* Discreto, a la derecha: deja la pantalla completa sin salir del kiosco */}
          <FullscreenButton variant="icon" className="ml-auto shrink-0" />
        </header>

        <div className="h-[calc(100vh-4rem)] sm:h-[calc(100vh-5rem)]">
          {screen === "tienda" && (
            <div className="h-full flex flex-col lg:flex-row">
              <main className="flex-1 min-h-0 min-w-0 flex flex-col p-3 sm:p-5 gap-3 sm:gap-4">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  placeholder="Buscar por nombre, referencia o código"
                  className="w-full bg-surface border border-field rounded-2xl px-4 sm:px-6 py-3 sm:py-4 text-lg sm:text-xl placeholder:text-lg sm:placeholder:text-xl placeholder:text-faint outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
                <div className="flex gap-2 overflow-x-auto pb-1 shrink-0">
                  {[null, ...categories].map((c) => (
                    <button
                      key={c ?? "todos"}
                      onClick={() => setCategory(c)}
                      className={`whitespace-nowrap px-5 min-h-12 rounded-full text-[17px] font-medium border ${category === c ? "bg-brand text-white border-brand" : "bg-surface text-body border-field"}`}
                    >
                      {c ?? "Todos"}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {catalogError && <div className="text-lg text-warn-ink bg-warn-soft border border-warn-line rounded-xl px-4 py-3 mb-3">No se pudo cargar el catálogo. <button className="underline font-semibold" onClick={loadCatalog}>Reintentar</button></div>}
                  {filtered.length === 0 ? (
                    <div className="text-center text-xl text-dim mt-20">{products.length === 0 && !catalogError ? "Cargando productos…" : "Sin resultados"}</div>
                  ) : (
                    <>
                      <div className="grid gap-3 sm:gap-4 grid-cols-[repeat(auto-fill,minmax(140px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
                        {filtered.slice(0, MAX_CARDS).map((p) => (
                          <KioskCard key={p.id} p={p} qty={qtyIn.get(p.id)} onAdd={() => addProduct(p)} />
                        ))}
                      </div>
                      {filtered.length > MAX_CARDS && <div className="text-center text-[16px] text-dim py-4">Mostrando {MAX_CARDS} de {filtered.length}. Escriba para buscar.</div>}
                    </>
                  )}
                </div>
              </main>

              <aside className="w-full lg:w-[400px] shrink-0 max-h-[48vh] lg:max-h-none bg-surface border-t lg:border-t-0 lg:border-l border-line flex flex-col">
                <div className="px-5 py-4 text-xl font-bold border-b border-line">Su compra</div>
                <div className="flex-1 overflow-y-auto">
                  {cart.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-center text-xl text-dim px-8">Escanee o toque un producto para empezar</div>
                  ) : (
                    <ul className="divide-y divide-line">
                      {cart.map((l) => (
                        <li key={l.productId} className="p-4">
                          <div className="text-[17px] font-medium leading-tight text-body">{l.name}</div>
                          <div className="text-[14px] text-dim">{l.barcode || l.sku} · {formatCOP(l.unitPrice)} c/u</div>
                          <div className="mt-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <button onClick={() => changeQty(l.productId, -1)} className="w-14 h-14 rounded-xl border border-field text-3xl leading-none active:bg-hover" aria-label="Menos">−</button>
                              <span className="w-12 text-center text-2xl font-bold">{l.qty}</span>
                              <button onClick={() => changeQty(l.productId, 1)} className="w-14 h-14 rounded-xl border border-field text-3xl leading-none active:bg-hover" aria-label="Más">+</button>
                            </div>
                            <div className="text-xl font-semibold">{formatCOP(cartTotals([l]).total)}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="p-5 border-t border-line space-y-2">
                  <div className="flex justify-between text-[16px] text-body"><span>Subtotal</span><span>{formatCOP(totals.subtotal)}</span></div>
                  <div className="flex justify-between text-[16px] text-body"><span>IVA</span><span>{formatCOP(totals.tax)}</span></div>
                  <div className="flex justify-between text-3xl font-bold text-brand-text pb-2"><span>Total</span><span>{formatCOP(totals.total)}</span></div>
                  <div className="flex gap-3">
                    <button onClick={() => setCart([])} disabled={cart.length === 0} className="px-6 rounded-xl border border-field text-lg font-medium text-body disabled:opacity-40">Vaciar</button>
                    <button onClick={() => { setFormError(""); setScreen("cedula"); }} disabled={cart.length === 0} className="flex-1 py-5 rounded-xl bg-go active:bg-go-hover text-white text-2xl font-bold disabled:opacity-50">
                      Pagar {formatCOP(totals.total)}
                    </button>
                  </div>
                </div>
              </aside>
            </div>
          )}

          {screen === "cedula" && (
            <CedulaStep
              total={totals.total}
              cfAllowed={cfAllowed}
              onBack={() => setScreen("tienda")}
              onChoose={(c: CedulaChoice) => {
                // Nada de la consulta se conserva: solo el modo y (si hace falta) el número que la persona escribió
                setCustMode(c.mode);
                setForm({ ...emptyCustomerForm({ state: defaultState, city: defaultCity }), identification: c.mode === "cf" ? "" : c.identification });
                setFormError("");
                setScreen("datos");
              }}
            />
          )}

          {screen === "datos" && (
            <CustomerStep
              mode={custMode}
              form={form}
              setForm={setForm}
              total={totals.total}
              error={formError}
              busy={busy}
              onBack={() => {
                setForm(emptyCustomerForm({ state: defaultState, city: defaultCity }));
                setCustMode("cf");
                setScreen("cedula");
              }}
              onNext={submitCustomer}
            />
          )}

          {screen === "pago" && (
            <KioskPayment
              cartTotal={totals.total}
              qrAvailable={qrAvailable}
              resume={resume}
              createSale={createSale}
              onBack={() => setScreen("datos")}
              onFinish={reset}
              onPhase={setPayPhase}
              registerAbort={(f) => {
                abortPay.current = f;
              }}
              onInvoiced={(id) => {
                if (printer) void printTicket(id);
              }}
            />
          )}
        </div>

        {idleWarn && (
          <div onPointerDown={() => setIdleWarn(false)} className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-inverse text-inverse-ink rounded-2xl px-8 py-4 text-xl shadow-2xl">
            ¿Sigue ahí? La pantalla se reiniciará pronto. Toque para continuar.
          </div>
        )}
        {toast && <div className={`fixed top-24 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl text-lg font-medium shadow-lg ${toast.kind === "err" ? "bg-err text-white" : "bg-inverse text-inverse-ink"}`}>{toast.text}</div>}

        {offline && (
          <div className="fixed inset-0 z-[60] bg-surface flex flex-col items-center justify-center gap-4 text-center p-10">
            <div className="text-7xl">⚠</div>
            <h1 className="text-4xl font-bold text-fg">Autoservicio no disponible, acérquese a la caja</h1>
            {screen === "pago" && !["choose", "creating"].includes(payPhase) ? <p className="text-xl text-soft">Si ya realizó su pago, acérquese a la caja y cuéntele a la persona que lo atiende.</p> : null}
          </div>
        )}
        {/* Aviso de inicio: el navegador NO deja entrar a pantalla completa sin un gesto del usuario,
            así que el primer toque del cliente la activa y abre el catálogo. Si el equipo ya arrancó en
            pantalla completa (acceso directo de Chrome --kiosk, ver README), este aviso no aparece. */}
        {showStart && (
          <button
            onClick={() => {
              void goFullscreen();
              setStartDismissed(true);
            }}
            className="fixed inset-0 z-[70] bg-surface flex flex-col items-center justify-center gap-6 text-center p-10"
          >
            <Logo className="h-24 w-44" />
            <div className="text-5xl font-extrabold text-fg">Toque para iniciar</div>
            <p className="text-2xl text-soft">Arme su compra y pague aquí mismo</p>
            <span className="mt-4 text-xl text-brand-text font-semibold">Toque en cualquier parte de la pantalla</span>
          </button>
        )}
        {exitOpen && <ExitDialog onCancel={() => setExitOpen(false)} />}
      </div>

      {/* Solo se ve al imprimir (si KIOSCO_IMPRESORA=true) */}
      {localTicket && (
        <div className="hidden print:block">
          <TicketView data={localTicket.data} config={localTicket.config} qrDataUrl={localTicket.qr} />
        </div>
      )}
    </>
  );
}


function KioskCard({ p, qty, onAdd }: { p: IndexedProduct; qty?: number; onAdd: () => void }) {
  return (
    <button onClick={onAdd} className="relative text-left bg-surface rounded-2xl border border-line p-3 active:scale-[0.98] active:border-brand transition">
      {qty ? <span className="absolute -top-2 -right-2 min-w-9 h-9 px-2 rounded-full bg-go text-white text-lg font-bold flex items-center justify-center shadow">{qty}</span> : null}
      <div className="h-32 flex items-center justify-center bg-subtle rounded-xl overflow-hidden">
        {p.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image_url} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-4xl font-bold text-dim">{p.name.slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <div className="mt-2 text-[17px] font-semibold leading-tight line-clamp-2 min-h-[2.8rem] text-body">{p.name}</div>
      <div className="text-[14px] text-dim truncate">{p.barcode || p.sku}</div>
      <div className="text-xl font-bold text-brand-text">{formatCOP(p.price)}</div>
    </button>
  );
}
