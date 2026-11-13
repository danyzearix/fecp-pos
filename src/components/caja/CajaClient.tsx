"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  buildIndex,
  fetchCatalog,
  loadCatalogMeta,
  loadLocalCatalog,
  normalize,
  requestIncrementalSync,
  saveCatalogMeta,
  saveLocalCatalog,
  searchItems,
  type IndexedProduct,
  type Product,
} from "@/lib/client/catalog";
import {
  enqueue,
  flushQueue,
  getQueue,
  markError,
  nextLocalNumber,
  pendingCount,
  removeFromQueue,
  sendSale,
} from "@/lib/client/queue";
import { printTicket } from "@/lib/client/print";
import { deletePendingReceipt, flushReceipts, savePendingReceipt, uploadReceipt } from "@/lib/client/receipts";
import { beepError, beepOk } from "@/lib/client/sound";
import { finePointer } from "@/lib/client/pointer";
import { newUuid } from "@/lib/client/uuid";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { cartTotals, formatCOP, type CartLine } from "@/lib/money";
import type { Role } from "@/lib/permissions";
import type { PosConfig, SaleIn, TicketData } from "@/lib/sale-types";
import { buildTicketFromSale } from "@/lib/ticket";
import TicketView from "@/components/ticket/TicketView";
import { POSCONFIG_KEY } from "@/components/ticket/TicketPage";
import CartPanel from "./CartPanel";
import CheckoutModal, { type CheckoutResult } from "./CheckoutModal";
import EpaycoCharge, { loadStoredSale, type EpaycoStart } from "./EpaycoCharge";
import { CONSUMIDOR_FINAL, type CartCustomer } from "./CustomerPicker";
import { IconSearch } from "./Icons";
import Sidebar from "./Sidebar";

const CART_KEY = "fecp_cart_v1";
const MAX_CARDS = 120; // tarjetas visibles a la vez (la búsqueda sigue siendo sobre todo el catálogo)

type Toast = { text: string; kind: "ok" | "err" } | null;

export default function CajaClient({
  user,
  config,
  epaycoReady,
}: {
  user: { name: string; role: Role };
  config: PosConfig;
  epaycoReady: boolean;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogState, setCatalogState] = useState<"cargando" | "ok" | "offline">("cargando");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartLoaded, setCartLoaded] = useState(false);
  const [customer, setCustomer] = useState<CartCustomer | null>(CONSUMIDOR_FINAL);
  const [toast, setToast] = useState<Toast>(null);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [showCheckout, setShowCheckout] = useState(false);
  const [saving, setSaving] = useState(false);
  const [epayCharge, setCharge] = useState<EpaycoStart | null>(null); // cobro con ePayco en curso (pantalla de espera)
  const [cartOpen, setCartOpen] = useState(false); // hoja del carrito (solo en tablet vertical y celular)
  const [localTicket, setLocalTicket] = useState<TicketData | null>(null); // tirilla impresa sin pasar por el servidor
  const [notice, setNotice] = useState<{ saleId: string; label: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Guardar la configuración para poder imprimir la tirilla sin conexión
  useEffect(() => {
    try {
      localStorage.setItem(POSCONFIG_KEY, JSON.stringify(config));
    } catch {}
  }, [config]);

  const index = useMemo(() => buildIndex(products), [products]);
  const deferredQuery = useDeferredValue(query);

  // ---- Catálogo: primero localStorage (instantáneo), luego el servidor ----
  const catalogVersion = useRef<string>("");
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | null>(null);

  /** Descarga el catálogo y lo deja en memoria y en localStorage, sin recargar la página. */
  const refreshCatalog = useCallback(async () => {
    const { products: p, version } = await fetchCatalog();
    setProducts(p);
    saveLocalCatalog(p);
    catalogVersion.current = version;
    const updatedAt = Date.now();
    setCatalogUpdatedAt(updatedAt);
    saveCatalogMeta({ updatedAt, version });
    setCatalogState("ok");
  }, []);

  useEffect(() => {
    const local = loadLocalCatalog();
    if (local.length) setProducts(local);
    const meta = loadCatalogMeta();
    if (meta) {
      setCatalogUpdatedAt(meta.updatedAt);
      catalogVersion.current = meta.version;
    }
    refreshCatalog().catch(() => setCatalogState("offline"));
  }, [refreshCatalog]);

  // ---- Sincronización incremental con WooCommerce: cada 10 min mientras la caja esté abierta y con conexión ----
  const INCREMENTAL_EVERY_MS = 10 * 60_000;
  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        const version = await requestIncrementalSync(); // el servidor evita sincronizaciones simultáneas
        if (version === null) return;
        if (version !== catalogVersion.current) await refreshCatalog(); // cambió el catálogo (aquí o en otra caja)
        else {
          const updatedAt = Date.now(); // sin cambios: sigue vigente
          setCatalogUpdatedAt(updatedAt);
          saveCatalogMeta({ updatedAt, version });
        }
      } catch {
        /* se reintenta en el siguiente ciclo */
      } finally {
        running = false;
      }
    };
    const first = setTimeout(tick, 5_000); // una al abrir la caja, sin frenar la carga inicial
    const iv = setInterval(tick, INCREMENTAL_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [refreshCatalog]);

  // En táctil NO se enfoca el buscador al abrir: el teclado en pantalla taparía medio catálogo.
  // Con mouse/teclado sí, para poder escanear y escribir de una vez.
  useEffect(() => {
    if (finePointer()) searchRef.current?.focus();
  }, []);

  // ---- Carrito persistente (si se recarga la pestaña no se pierde) ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CART_KEY);
      if (raw) setCart(JSON.parse(raw));
    } catch {}
    setCartLoaded(true);
  }, []);
  useEffect(() => {
    if (!cartLoaded) return;
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {}
  }, [cart, cartLoaded]);

  // ---- Retomar un cobro con ePayco en curso (ePayco devuelve a /caja?ref_payco=... o se recargó la pestaña) ----
  useEffect(() => {
    const s = loadStoredSale();
    if (!s) return;
    const q = new URLSearchParams(location.search);
    const ref = (q.get("ref_payco") || q.get("x_ref_payco") || "").trim();
    if (ref) history.replaceState(null, "", location.pathname); // limpia la URL
    // Diagnóstico: qué trae la vuelta de ePayco (solo NOMBRES de parámetros, nunca valores)
    void fetch(`/api/kiosco/pagos/${s.id}/hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook: "retomar", keys: [`parametros:${[...q.keys()].join(",") || "ninguno"}`], refFound: !!ref }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCharge({ mode: "resume", sale: s, ref: ref || null }); // el ref es solo una PISTA: el servidor la verifica con ePayco
  }, []);

  // ---- Conexión y ventas pendientes ----
  useEffect(() => {
    const upd = () => setOnline(navigator.onLine);
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    const iv = setInterval(() => setPending(pendingCount()), 2000);
    setPending(pendingCount());
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
      clearInterval(iv);
    };
  }, []);

  const showToast = useCallback((text: string, kind: "ok" | "err") => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // ---- Carrito ----
  const addProduct = useCallback(
    (p: Product, qty = 1) => {
      if (!p.sku) {
        beepError();
        showToast(`"${p.name}" no tiene SKU y no se puede facturar`, "err");
        return;
      }
      beepOk();
      setCart((prev) => {
        const i = prev.findIndex((l) => l.productId === p.id);
        if (i >= 0) {
          const next = [...prev];
          next[i] = { ...next[i], qty: next[i].qty + qty };
          return next;
        }
        return [
          ...prev,
          {
            productId: p.id,
            sku: p.sku,
            barcode: p.barcode,
            name: p.name,
            unitPrice: p.price,
            taxRate: p.tax_rate,
            includesTax: p.prices_include_tax,
            qty,
          },
        ];
      });
    },
    [showToast]
  );

  const changeQty = (productId: number, delta: number) =>
    setCart((prev) =>
      prev.flatMap((l) => {
        if (l.productId !== productId) return [l];
        const q = l.qty + delta;
        return q <= 0 ? [] : [{ ...l, qty: q }];
      })
    );
  const removeLine = (productId: number) => setCart((prev) => prev.filter((l) => l.productId !== productId));
  const clearCart = () => {
    setCart([]);
    setCustomer(CONSUMIDOR_FINAL);
  };

  const totals = useMemo(() => cartTotals(cart), [cart]);
  const cartCount = useMemo(() => cart.reduce((a, l) => a + l.qty, 0), [cart]);

  // ---- Cobrar: abre el modal (F9 dentro del modal confirma la venta) ----
  const charge = useCallback(() => {
    if (cart.length === 0 || showCheckout) return;
    setShowCheckout(true);
  }, [cart.length, showCheckout]);

  // ---- Confirmar venta: 1) guardar en la cola local  2) enviar  3) imprimir ----
  const completeSale = useCallback(
    async (r: CheckoutResult) => {
      if (saving) return;
      // Pago electrónico: NO se registra como venta normal. El servidor crea la venta 'esperando_pago', verifica el pago
      // con ePayco y solo entonces factura. El carrito se vacía únicamente cuando el pago queda recibido.
      if (r.paymentMethod === "epayco") {
        setShowCheckout(false);
        setCartOpen(false);
        setCharge({ mode: "new", cart, result: r, total: totals.total });
        return;
      }
      setSaving(true);
      const sale: SaleIn = {
        id: newUuid(),
        local_number: nextLocalNumber(config.prefix),
        created_at_device: new Date().toISOString(),
        checkout_type: r.checkoutType,
        payment_method: r.paymentMethod,
        payment_reference: r.paymentReference,
        cash_received: r.cashReceived,
        customer: r.customer,
        items: cart.map((l) => ({
          product_id: l.productId,
          sku: l.sku ?? "",
          name: l.name,
          quantity: l.qty,
          unit_price: l.unitPrice,
          tax_rate: l.taxRate,
          prices_include_tax: l.includesTax,
        })),
      };

      // El comprobante (si hay) se guarda en este equipo (IndexedDB) ANTES de enviar la venta: si no hay conexión, se sube
      // después, cuando la venta ya exista en el servidor.
      let receiptStored = false;
      if (r.receipt) {
        receiptStored = await savePendingReceipt({ saleId: sale.id, localNumber: sale.local_number, blob: r.receipt, createdAt: Date.now() })
          .then(() => true)
          .catch(() => false);
      }

      // La venta queda guardada en este equipo ANTES de enviarla
      enqueue({ sale, cashierName: user.name, queuedAt: Date.now(), state: "pendiente" });
      setCart([]);
      setCustomer(CONSUMIDOR_FINAL);
      setShowCheckout(false);
      setCartOpen(false);
      setPending(pendingCount());
      searchRef.current?.focus();

      const res = await sendSale(sale);
      if (res.kind === "ok") {
        removeFromQueue(sale.id);
        showToast(`Venta ${sale.local_number} registrada`, "ok");
        if (r.receipt) {
          // La venta ya existe: subir el comprobante ahora (si falla la red, queda en el equipo y se reintenta solo)
          const blob = r.receipt;
          void uploadReceipt(sale.id, blob).then((u) => {
            if (u.kind === "ok") void deletePendingReceipt(sale.id).catch(() => {});
            else if (u.kind === "rejected") {
              void deletePendingReceipt(sale.id).catch(() => {});
              showToast(`El comprobante de ${sale.local_number} no se guardó: ${u.error}. Adjúntelo desde Ventas.`, "err");
            } else if (!receiptStored) {
              showToast(`No se pudo guardar el comprobante de ${sale.local_number}. Adjúntelo desde Ventas.`, "err");
            }
          });
        }
        if (res.status === "invoiced") printTicket(sale.id);
        else setLocalTicket(buildTicketFromSale(sale, user.name));
      } else if (res.kind === "rejected") {
        markError(sale.id, res.error);
        beepError();
        showToast(`El servidor rechazó la venta: ${res.error}`, "err");
      } else {
        // Sin conexión / sesión vencida: queda en la cola y se envía sola después
        showToast(`Venta ${sale.local_number} guardada. Se enviará al volver la conexión.`, "ok");
        setLocalTicket(buildTicketFromSale(sale, user.name));
      }
      setPending(pendingCount());
      setSaving(false);
    },
    [cart, config.prefix, saving, showToast, totals.total, user.name]
  );

  // Tirilla local: imprimir cuando se arma
  useEffect(() => {
    if (!localTicket) return;
    const t = setTimeout(() => window.print(), 150);
    const after = () => setLocalTicket(null);
    window.addEventListener("afterprint", after, { once: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", after);
    };
  }, [localTicket]);

  // ---- Enviar ventas pendientes: al iniciar, al volver la conexión y cada 30 s ----
  // Primero las ventas; después los comprobantes guardados en el equipo (solo los de ventas que ya llegaron al servidor).
  useEffect(() => {
    const run = async () => {
      await flushQueue(
        (q, r) => {
          setPending(pendingCount());
          if (r.status === "invoiced") {
            setNotice({ saleId: q.sale.id, label: r.invoiceName ?? q.sale.local_number });
          }
        },
        (q, err) => showToast(`La venta ${q.sale.local_number} fue rechazada: ${err}`, "err")
      );
      await flushReceipts(new Set(getQueue().map((q) => q.sale.id)), (p, err) =>
        showToast(`El comprobante de ${p.localNumber} no se pudo subir: ${err}. Adjúntelo desde Ventas.`, "err")
      );
    };
    run();
    const iv = setInterval(run, 30_000);
    window.addEventListener("online", run);
    return () => {
      clearInterval(iv);
      window.removeEventListener("online", run);
    };
  }, [showToast]);

  // ---- Lector de códigos (pistola) ----
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
  useBarcodeScanner(handleCode, !showCheckout && !epayCharge);

  // ---- Atajos: F2 buscador, F9 cobrar (con el modal abierto, F9 y Esc los maneja el modal) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showCheckout || epayCharge) return;
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F9") {
        e.preventDefault();
        charge();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [charge, showCheckout, epayCharge]);

  // ---- Búsqueda ----
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.category) set.add(p.category);
    return [...set].sort((a, b) => a.localeCompare(b, "es"));
  }, [products]);

  const filtered = useMemo(
    () => searchItems(index.items, deferredQuery, category),
    [index, deferredQuery, category]
  );
  const visible = filtered.slice(0, MAX_CARDS);

  const qtyInCart = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of cart) m.set(l.productId, l.qty);
    return m;
  }, [cart]);

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

  return (
    <>
    {/* Celular: barra superior + contenido. Tablet/PC: columna lateral + contenido */}
    <div className="h-screen flex flex-col md:flex-row bg-app overflow-hidden print:hidden">
      <Sidebar
        userName={user.name}
        role={user.role}
        online={online}
        pending={pending}
        catalogUpdatedAt={catalogUpdatedAt}
      />

      {/* Centro */}
      {/* pb-20 deja sitio al botón fijo "Ver carrito" que aparece por debajo de lg */}
      <main className="flex-1 min-w-0 flex flex-col p-3 sm:p-4 gap-3 pb-20 lg:pb-4">
        <div className="relative">
          <IconSearch className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-dim" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Buscar por producto, referencia o código"
            className="w-full bg-surface border border-field rounded-xl pl-12 pr-4 py-3.5 text-lg placeholder:text-lg placeholder:text-faint outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 shrink-0">
          {[null, ...categories].map((c) => (
            <button
              key={c ?? "todos"}
              onClick={() => setCategory(c)}
              className={`whitespace-nowrap px-4 min-h-11 rounded-full text-sm font-medium border ${
                category === c
                  ? "bg-brand text-white border-brand"
                  : "bg-surface text-body border-field hover:bg-hover"
              }`}
            >
              {c ?? "Todos"}
            </button>
          ))}
        </div>

        {catalogState === "offline" && (
          <div className="text-sm bg-warn-soft text-warn-ink border border-warn-line rounded-lg px-3 py-2">
            No se pudo actualizar el catálogo. {products.length ? "Usando el catálogo guardado en este equipo." : "No hay catálogo guardado."}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {catalogState === "cargando" && products.length === 0 ? (
            <div className="text-dim text-center mt-16">Cargando catálogo…</div>
          ) : visible.length === 0 ? (
            <div className="text-dim text-center mt-16">
              {products.length === 0
                ? "No hay productos. Un administrador debe sincronizarlos en Productos."
                : "Sin resultados"}
            </div>
          ) : (
            <>
              <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(110px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(125px,1fr))]">
                {visible.map((p) => (
                  <ProductCard key={p.id} p={p} qty={qtyInCart.get(p.id)} onAdd={() => addProduct(p)} />
                ))}
              </div>
              {filtered.length > MAX_CARDS && (
                <div className="text-center text-sm text-dim py-3">
                  Mostrando {MAX_CARDS} de {filtered.length}. Escribe para filtrar.
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Fondo oscuro detrás de la hoja del carrito (solo por debajo de lg) */}
      {cartOpen && <div className="lg:hidden fixed inset-0 z-30 bg-black/50" onClick={() => setCartOpen(false)} />}

      {/* Un solo carrito: columna fija desde lg (tablet horizontal y PC); hoja deslizable por debajo */}
      <CartPanel
        sellerName={user.name}
        lines={cart}
        totals={totals}
        customer={customer}
        onCustomer={setCustomer}
        onQty={changeQty}
        onRemove={removeLine}
        onClear={clearCart}
        onCharge={charge}
        onClose={() => setCartOpen(false)}
        className={`bg-surface border-line flex flex-col transition-transform
          fixed inset-y-0 right-0 z-40 w-full max-w-[420px] border-l shadow-2xl
          ${cartOpen ? "translate-x-0" : "translate-x-full"}
          lg:static lg:z-auto lg:w-[400px] lg:max-w-none lg:shrink-0 lg:translate-x-0 lg:shadow-none lg:transition-none`}
      />

      {/* Botón fijo para abrir el carrito (tablet vertical y celular) */}
      <button
        onClick={() => setCartOpen(true)}
        className="lg:hidden fixed bottom-0 inset-x-0 z-20 flex items-center justify-between gap-3 px-5 py-4 min-h-14 bg-go text-white text-[17px] font-bold shadow-[0_-2px_12px_rgba(0,0,0,0.18)]"
      >
        <span>Ver carrito ({cartCount})</span>
        <span>{formatCOP(totals.total)}</span>
      </button>

      {showCheckout && (
        <CheckoutModal
          totals={totals}
          customer={customer}
          config={config}
          epaycoReady={epaycoReady}
          busy={saving}
          onClose={() => setShowCheckout(false)}
          onConfirm={completeSale}
        />
      )}

      {epayCharge && (
        <EpaycoCharge
          start={epayCharge}
          onFinished={() => {
            // El pago quedó recibido: ahora sí se vacía el carrito
            setCharge(null);
            clearCart();
            searchRef.current?.focus();
          }}
          onClose={() => {
            setCharge(null);
            searchRef.current?.focus();
          }}
        />
      )}

      {notice && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-surface border border-ok-line shadow-lg rounded-xl px-5 py-3 flex items-center gap-4">
          <span className="text-[14px] text-body">
            La venta pendiente quedó facturada: <b>{notice.label}</b>
          </span>
          <button
            onClick={() => {
              printTicket(notice.saleId);
              setNotice(null);
            }}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-[14px] font-semibold"
          >
            Reimprimir factura
          </button>
          <button onClick={() => setNotice(null)} className="text-dim text-xl leading-none">
            ×
          </button>
        </div>
      )}

      {toast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-lg shadow-lg font-medium ${
            toast.kind === "err" ? "bg-err text-white" : "bg-inverse text-inverse-ink"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>

    {/* Solo se ve al imprimir: tirilla armada con los datos locales (sirve sin conexión) */}
    {localTicket && (
      <div className="hidden print:block">
        <TicketView data={localTicket} config={config} />
      </div>
    )}
    </>
  );
}

function ProductCard({ p, qty, onAdd }: { p: IndexedProduct; qty?: number; onAdd: () => void }) {
  return (
    <button
      onClick={onAdd}
      className={`relative text-left bg-surface rounded-lg border p-1.5 hover:shadow-md hover:border-brand transition ${
        p.sku ? "border-line" : "border-warn-line opacity-70"
      }`}
    >
      {qty ? (
        <span className="absolute -top-2 -right-2 min-w-6 h-6 px-1.5 rounded-full bg-go text-white text-xs font-bold flex items-center justify-center shadow">
          {qty}
        </span>
      ) : null}
      <div className="h-16 flex items-center justify-center bg-subtle rounded-md overflow-hidden">
        {p.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image_url} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-xl font-bold text-dim">{p.name.slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <div className="mt-1.5 text-[13px] font-medium leading-4 line-clamp-2 min-h-8 text-body">{p.name}</div>
      <div className="text-xs leading-4 text-dim truncate">{p.sku ? p.barcode || p.sku : "Sin SKU"}</div>
      <div className="text-[15px] leading-5 font-bold text-brand-text">{formatCOP(p.price)}</div>
    </button>
  );
}
