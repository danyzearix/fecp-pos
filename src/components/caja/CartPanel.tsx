"use client";

import { formatCOP, lineAmounts, type CartLine } from "@/lib/money";
import CustomerPicker, { type CartCustomer } from "./CustomerPicker";
import { IconTrash } from "./Icons";

type Props = {
  sellerName: string;
  lines: CartLine[];
  totals: { subtotal: number; tax: number; total: number };
  customer: CartCustomer | null;
  onCustomer: (c: CartCustomer | null) => void;
  onQty: (productId: number, delta: number) => void;
  onRemove: (productId: number) => void;
  onClear: () => void;
  onCharge: () => void;
  /** clases del contenedor: columna fija en pantallas anchas, hoja deslizable en angostas */
  className?: string;
  /** cerrar la hoja (solo se muestra el botón en pantallas angostas) */
  onClose?: () => void;
};

// Estilos del panel (paleta: #374151 etiquetas, #4b5563 valores, #6b7280 secundario, #1f2937 cifras)
const LABEL = "text-[13px] font-semibold text-body mb-1";
const VALUE_BOX =
  "text-[14px] text-soft bg-subtle border border-line rounded-lg px-3 py-2";

export default function CartPanel(p: Props) {
  return (
    <section className={p.className ?? "w-full lg:w-[400px] shrink-0 bg-surface border-l border-line flex flex-col"}>
      {/* Encabezado de la hoja: solo en pantallas angostas */}
      {p.onClose && (
        <div className="lg:hidden flex items-center justify-between px-4 py-2 border-b border-line">
          <span className="text-[15px] font-bold text-fg">Carrito</span>
          <button onClick={p.onClose} aria-label="Cerrar carrito" className="w-11 h-11 rounded-lg text-dim hover:bg-hover text-2xl leading-none">
            ×
          </button>
        </div>
      )}
      <div className="p-4 space-y-3 border-b border-line">
        <div>
          <div className={LABEL}>Tipo de comprobante</div>
          <div className={VALUE_BOX}>Factura electrónica de venta</div>
        </div>
        <div>
          <div className={LABEL}>Vendedor</div>
          <div className={VALUE_BOX}>{p.sellerName}</div>
        </div>
        <div>
          <div className={LABEL}>Cliente</div>
          <CustomerPicker customer={p.customer} onChange={p.onCustomer} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {p.lines.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[14px] text-dim text-center px-8">
            Escanea o selecciona un producto para empezar
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {p.lines.map((l) => (
              <li key={l.productId} className="p-3">
                <div className="flex justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium leading-4 text-body">{l.name}</div>
                    <div className="text-[12px] text-dim">
                      {l.barcode || l.sku} · {formatCOP(l.unitPrice)} c/u
                    </div>
                  </div>
                  <button
                    onClick={() => p.onRemove(l.productId)}
                    title="Eliminar"
                    className="w-11 h-11 -mt-2 -mr-2 shrink-0 flex items-center justify-center rounded-lg text-dim hover:text-err-ink hover:bg-hover"
                  >
                    <IconTrash className="w-5 h-5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  {/* Objetivo táctil de 44 px: en tablet/celular los − y + son más grandes */}
                  <div className="flex items-center border border-field rounded-lg overflow-hidden text-[16px] text-fg">
                    <button onClick={() => p.onQty(l.productId, -1)} aria-label="Quitar uno" className="w-11 h-11 text-xl hover:bg-hover active:bg-hover">
                      −
                    </button>
                    <span className="w-10 text-center font-semibold">{l.qty}</span>
                    <button onClick={() => p.onQty(l.productId, 1)} aria-label="Agregar uno" className="w-11 h-11 text-xl hover:bg-hover active:bg-hover">
                      +
                    </button>
                  </div>
                  <div className="text-[14px] font-semibold text-fg">{formatCOP(lineAmounts(l).total)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="p-4 border-t border-line space-y-1 bg-surface">
        <div className="flex justify-between">
          <span className="text-[13px] text-body">Subtotal</span>
          <span className="text-[14px] text-fg">{formatCOP(p.totals.subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[13px] text-body">IVA</span>
          <span className="text-[14px] text-fg">{formatCOP(p.totals.tax)}</span>
        </div>
        <div className="flex justify-between text-[16px] font-bold text-brand-text pb-2">
          <span>Total</span>
          <span>{formatCOP(p.totals.total)}</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={p.onClear}
            disabled={p.lines.length === 0}
            className="px-4 min-h-11 rounded-lg border border-field text-[14px] text-body font-medium disabled:opacity-40"
          >
            Vaciar
          </button>
          <button
            onClick={p.onCharge}
            disabled={p.lines.length === 0}
            className="flex-1 py-4 rounded-lg bg-go hover:bg-go-hover text-white text-xl font-bold disabled:opacity-50"
          >
            Cobrar {formatCOP(p.totals.total)}
          </button>
        </div>
        {/* Los atajos solo aplican con teclado físico */}
        <div className="text-[11px] text-dim text-center hidden md:block">F2 buscar · F9 cobrar</div>
      </div>
    </section>
  );
}
