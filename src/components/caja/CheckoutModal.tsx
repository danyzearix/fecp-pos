"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReceiptCapture from "@/components/ReceiptCapture";
import { receiptAllowed, receiptRequired } from "@/lib/receipt-rules";
import { DEPTS, citiesOf, EMAIL_RE, nitDv, splitName } from "@/lib/client/customer-form";
import { finePointer } from "@/lib/client/pointer";
import { formatCOP, round2 } from "@/lib/money";
import {
  CONSUMIDOR_FINAL_ID,
  ID_TYPES,
  PAYMENT_METHODS,
  requiresReference,
  type CustomerIn,
  type PaymentMethod,
  type PosConfig,
} from "@/lib/sale-types";
import type { CartCustomer } from "./CustomerPicker";

export type CheckoutResult = {
  checkoutType: "corto" | "completo";
  customer: CustomerIn | null;
  paymentMethod: PaymentMethod;
  paymentReference: string | null;
  cashReceived: number | null;
  /** foto del comprobante (ya reducida). Obligatoria en transferencia, opcional en tarjeta; null si no aplica. */
  receipt: Blob | null;
};

type Props = {
  totals: { subtotal: number; tax: number; total: number };
  customer: CartCustomer | null;
  config: PosConfig;
  /** ¿Está lista la configuración de ePayco (llaves + facturación)? Si no, el botón queda deshabilitado */
  epaycoReady: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (r: CheckoutResult) => void;
};

type Form = {
  idType: string; identification: string; dv: string; company: string;
  name: string; first: string; last: string;
  email: string; phone: string; address: string; state: string; city: string;
};

const QUICK_BILLS = [10000, 20000, 50000, 100000];

const inputCls =
  "w-full border border-field rounded-lg px-3 py-2 text-[15px] text-fg placeholder:text-[15px] placeholder:text-faint outline-none focus:border-brand bg-surface";
const labelCls = "block text-[13px] font-semibold text-body";

export default function CheckoutModal({ totals, customer, config, epaycoReady, busy, onClose, onConfirm }: Props) {
  const threshold = 5 * config.uvt;
  const forceFull = totals.subtotal > threshold;
  const [manualFull, setManualFull] = useState(false);
  const type: "corto" | "completo" = forceFull || manualFull ? "completo" : "corto";

  const prefill = customer && customer.identification !== CONSUMIDOR_FINAL_ID ? customer : null;
  const [f, setF] = useState<Form>(() => ({
    idType: prefill?.id_type ?? "13",
    identification: prefill?.identification ?? "",
    dv: prefill?.check_digit ?? "",
    company: prefill?.company_name ?? "",
    name: prefill ? [prefill.first_name, prefill.last_name].filter(Boolean).join(" ") || prefill.company_name || "" : "",
    first: prefill?.first_name ?? "",
    last: prefill?.last_name ?? "",
    email: prefill?.email ?? "",
    phone: prefill?.phone ?? "",
    address: prefill?.address ?? "",
    state: prefill?.state_code ?? config.defaultStateCode,
    city: prefill?.city_code ?? config.defaultCityCode,
  }));
  const set = (k: keyof Form, v: string) => setF((p) => ({ ...p, [k]: v }));
  const [found, setFound] = useState(false);

  const [method, setMethodState] = useState<PaymentMethod>("efectivo");
  const [reference, setReference] = useState("");
  const [verified, setVerified] = useState(false);
  const isEpayco = method === "epayco"; // el pago lo verifica el servidor con ePayco: no hay referencia ni casilla
  const needsRef = requiresReference(method) && !isEpayco;
  // Al cambiar de medio hay que volver a verificar el pago
  const setMethod = (m: PaymentMethod) => {
    setMethodState(m);
    setVerified(false);
  };
  // Comprobante (evidencia para auditoría): NO reemplaza la referencia ni la casilla
  const [receipt, setReceipt] = useState<Blob | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const receiptUrl = useMemo(() => (receipt ? URL.createObjectURL(receipt) : null), [receipt]);
  useEffect(() => () => {
    if (receiptUrl) URL.revokeObjectURL(receiptUrl);
  }, [receiptUrl]);
  const receiptOk = receiptAllowed(method);
  const receiptMust = receiptRequired(method);
  // En táctil no se enfoca solo: el teclado en pantalla taparía el modal al abrirlo
  const [autoFocusFields] = useState(() => (typeof window === "undefined" ? false : finePointer()));
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const upd = () => setOnline(navigator.onLine);
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
    };
  }, []);
  const [cashStr, setCashStr] = useState("");
  const cash = Number(cashStr.replace(/\D/g, "")) || 0;
  const change = round2(cash - totals.total);

  // Al pasar a checkout completo, si no hay datos de ubicación, usar los del punto de venta
  const cities = useMemo(() => citiesOf(f.state), [f.state]);

  // NIT: calcular el dígito de verificación automáticamente (se puede corregir a mano)
  useEffect(() => {
    if (f.idType === "31") setF((p) => ({ ...p, dv: nitDv(p.identification) }));
  }, [f.idType, f.identification]);

  // Autocompletar si la identificación ya existe en customers
  const seq = useRef(0);
  useEffect(() => {
    const id = f.identification.trim();
    setFound(false);
    if (id.length < 5) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(id)}`);
        if (!res.ok || mine !== seq.current) return;
        const { customers } = (await res.json()) as { customers: CartCustomer[] };
        const c = customers.find((x) => x.identification === id);
        if (!c || mine !== seq.current) return;
        setFound(true);
        setF((p) => ({
          ...p,
          idType: c.id_type || p.idType,
          company: c.company_name ?? "",
          first: c.first_name ?? "",
          last: c.last_name ?? "",
          name: c.company_name || [c.first_name, c.last_name].filter(Boolean).join(" "),
          email: c.email ?? p.email,
          phone: c.phone ?? p.phone,
          address: c.address ?? p.address,
          state: c.state_code || p.state,
          city: c.city_code || p.city,
        }));
      } catch {
        /* sin conexión: se llena a mano */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [f.identification]);

  // ---- Validación ----
  function validate(): string | null {
    const id = f.identification.trim();
    if (type === "corto") {
      if (id && !f.name.trim()) return "Escribe el nombre del cliente (o borra la cédula para Consumidor final)";
      // Siigo exige nombres y apellidos por separado para personas
      if (id && f.idType !== "31" && f.name.trim().split(/\s+/).length < 2) return "Escribe nombre y apellido del cliente";
      if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) return "El correo no es válido";
    } else {
      if (!id) return "Escribe el número de documento";
      if (id === CONSUMIDOR_FINAL_ID) return "Con checkout completo no se puede usar Consumidor final";
      if (f.idType === "31") {
        if (!/^\d{5,15}$/.test(id)) return "El NIT debe tener solo números";
        if (!/^\d$/.test(f.dv)) return "Falta el dígito de verificación";
        if (!f.company.trim()) return "Escribe la razón social";
      } else {
        if (!f.first.trim() || !f.last.trim()) return "Escribe nombres y apellidos";
      }
      if (!EMAIL_RE.test(f.email.trim())) return "Escribe un correo válido";
      if (!f.address.trim()) return "Escribe la dirección";
      if (!f.state || !f.city) return "Selecciona departamento y ciudad";
    }
    if (isEpayco && !epaycoReady) return "El pago electrónico no está disponible (revise la configuración de ePayco)";
    if (isEpayco && !online) return "Sin conexión: el pago electrónico necesita internet";
    if (method === "efectivo" && cash + 0.005 < totals.total) return "El valor recibido es menor al total";
    if (needsRef && !reference.trim()) return "Escribe la referencia o los últimos dígitos del comprobante";
    if (needsRef && !verified) return "Marca la casilla: verificaste el pago en el datáfono o en la cuenta";
    if (receiptMust && !receipt) return "Toma la foto del comprobante (obligatoria en transferencias)";
    return null;
  }
  const error = validate();

  function buildCustomer(): CustomerIn | null {
    const id = f.identification.trim();
    if (type === "corto") {
      if (!id) return null;
      if (f.idType === "31") {
        return { id_type: "31", identification: id, check_digit: f.dv, company_name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() };
      }
      const [first, last] = splitName(f.name);
      return { id_type: f.idType, identification: id, first_name: first, last_name: last, email: f.email.trim(), phone: f.phone.trim() };
    }
    return {
      id_type: f.idType,
      identification: id,
      check_digit: f.idType === "31" ? f.dv : "",
      company_name: f.idType === "31" ? f.company.trim() : "",
      first_name: f.idType === "31" ? "" : f.first.trim(),
      last_name: f.idType === "31" ? "" : f.last.trim(),
      email: f.email.trim(),
      phone: f.phone.trim(),
      address: f.address.trim(),
      state_code: f.state,
      city_code: f.city,
    };
  }

  function confirm() {
    if (busy || error) return;
    onConfirm({
      checkoutType: type,
      customer: buildCustomer(),
      paymentMethod: method,
      paymentReference: needsRef ? reference.trim() : null,
      cashReceived: method === "efectivo" ? cash : null,
      receipt: receiptOk ? receipt : null,
    });
  }

  // Atajos del modal: F9 confirma, Esc cierra
  const camOpenRef = useRef(false);
  useEffect(() => {
    camOpenRef.current = camOpen;
  }, [camOpen]);
  const confirmRef = useRef(confirm);
  useEffect(() => {
    confirmRef.current = confirm;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (camOpenRef.current) return; // la cámara está abierta: ella maneja sus teclas
      if (e.key === "F9") {
        e.preventDefault();
        confirmRef.current();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isNit = f.idType === "31";

  return (
    // En celular y tablet vertical ocupa toda la pantalla; desde lg vuelve a ser una ventana centrada
    <div className="fixed inset-0 z-40 bg-black/50 flex items-stretch lg:items-center justify-center lg:p-4">
      <div className="bg-surface shadow-2xl w-full h-full lg:h-auto lg:rounded-2xl lg:max-w-[980px] lg:max-h-[94vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-line shrink-0">
          <h2 className="text-lg font-bold text-fg">Cobrar venta</h2>
          <button onClick={onClose} className="w-11 h-11 rounded-lg text-2xl leading-none text-dim hover:text-fg hover:bg-hover" title="Cerrar (Esc)" aria-label="Cerrar">
            ×
          </button>
        </div>

        {/* Una sola columna con scroll propio en angosto; dos paneles desde lg */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] overflow-y-auto lg:overflow-hidden">
          {/* ---------- Izquierda: cliente ---------- */}
          <div className="p-4 sm:p-6 lg:overflow-y-auto space-y-4 border-b lg:border-b-0 lg:border-r border-line">
            <div
              className={`rounded-lg px-4 py-3 text-[13px] ${
                type === "completo" ? "bg-warn-soft border border-warn-line text-warn-ink" : "bg-brand-soft border border-brand-line text-brand-ink"
              }`}
            >
              <div className="font-bold text-[14px]">
                Checkout {type === "completo" ? "COMPLETO" : "CORTO"}
              </div>
              {forceFull ? (
                <div>
                  La base sin IVA ({formatCOP(totals.subtotal)}) supera 5 UVT ({formatCOP(threshold)}): se requieren todos los datos del cliente.
                </div>
              ) : (
                <div>
                  La base sin IVA ({formatCOP(totals.subtotal)}) es menor o igual a 5 UVT ({formatCOP(threshold)}): los datos del cliente son opcionales.
                </div>
              )}
              {!forceFull && (
                <label className="mt-1.5 flex items-center gap-2 cursor-pointer font-medium">
                  <input type="checkbox" checked={manualFull} onChange={(e) => setManualFull(e.target.checked)} />
                  El cliente pide factura con todos sus datos (checkout completo)
                </label>
              )}
            </div>

            {type === "corto" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="sm:col-span-2">
                  <span className={labelCls}>Cédula (opcional — vacía = Consumidor final)</span>
                  <input className={inputCls} inputMode="numeric" value={f.identification} onChange={(e) => set("identification", e.target.value)} placeholder="Número de cédula" />
                </label>
                {found && <p className="sm:col-span-2 text-[13px] text-ok-ink font-medium">✓ Cliente encontrado: datos autocompletados</p>}
                <label className="sm:col-span-2">
                  <span className={labelCls}>Nombre</span>
                  <input className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Nombre del cliente" />
                </label>
                <label>
                  <span className={labelCls}>Correo</span>
                  <input className={inputCls} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="correo@ejemplo.com" />
                </label>
                <label>
                  <span className={labelCls}>Teléfono</span>
                  <input className={inputCls} inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="Teléfono" />
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <label className="col-span-2 sm:col-span-3">
                  <span className={labelCls}>Tipo de documento</span>
                  <select className={inputCls} value={f.idType} onChange={(e) => set("idType", e.target.value)}>
                    {ID_TYPES.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </label>
                <label className={isNit ? "col-span-1 sm:col-span-2" : "col-span-2 sm:col-span-3"}>
                  <span className={labelCls}>Número{isNit ? " (sin DV)" : ""}</span>
                  <input className={inputCls} inputMode="numeric" value={f.identification} onChange={(e) => set("identification", e.target.value)} placeholder="Número de documento" />
                </label>
                {isNit && (
                  <label>
                    <span className={labelCls}>DV</span>
                    <input className={inputCls} maxLength={1} inputMode="numeric" value={f.dv} onChange={(e) => set("dv", e.target.value.replace(/\D/g, ""))} />
                  </label>
                )}
                {found && <p className="col-span-2 sm:col-span-6 text-[13px] text-ok-ink font-medium">✓ Cliente encontrado: datos autocompletados</p>}
                {isNit ? (
                  <label className="col-span-2 sm:col-span-6">
                    <span className={labelCls}>Razón social</span>
                    <input className={inputCls} value={f.company} onChange={(e) => set("company", e.target.value)} placeholder="Razón social" />
                  </label>
                ) : (
                  <>
                    <label className="col-span-2 sm:col-span-3">
                      <span className={labelCls}>Nombres</span>
                      <input className={inputCls} value={f.first} onChange={(e) => set("first", e.target.value)} placeholder="Nombres" />
                    </label>
                    <label className="col-span-2 sm:col-span-3">
                      <span className={labelCls}>Apellidos</span>
                      <input className={inputCls} value={f.last} onChange={(e) => set("last", e.target.value)} placeholder="Apellidos" />
                    </label>
                  </>
                )}
                <label className="col-span-2 sm:col-span-3">
                  <span className={labelCls}>Correo</span>
                  <input className={inputCls} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="correo@ejemplo.com" />
                </label>
                <label className="col-span-2 sm:col-span-3">
                  <span className={labelCls}>Teléfono</span>
                  <input className={inputCls} inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="Teléfono" />
                </label>
                <label className="col-span-2 sm:col-span-6">
                  <span className={labelCls}>Dirección</span>
                  <input className={inputCls} value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="Dirección" />
                </label>
                <label className="col-span-2 sm:col-span-3">
                  <span className={labelCls}>Departamento</span>
                  <select
                    className={inputCls}
                    value={f.state}
                    onChange={(e) => {
                      const first = citiesOf(e.target.value)[0];
                      setF((p) => ({ ...p, state: e.target.value, city: first ? first[0] : "" }));
                    }}
                  >
                    <option value="">Seleccionar…</option>
                    {DEPTS.map((d) => (
                      <option key={d.code} value={d.code}>{d.name}</option>
                    ))}
                  </select>
                </label>
                <label className="col-span-2 sm:col-span-3">
                  <span className={labelCls}>Ciudad</span>
                  <select className={inputCls} value={f.city} onChange={(e) => set("city", e.target.value)}>
                    <option value="">Seleccionar…</option>
                    {cities.map(([code, name]) => (
                      <option key={code} value={code}>{name}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>

          {/* ---------- Derecha: pago ---------- */}
          <div className="p-4 sm:p-6 lg:overflow-y-auto space-y-4 bg-subtle">
            <div className="text-center">
              <div className="text-[13px] font-semibold text-body">Total a pagar</div>
              <div className="text-4xl font-extrabold text-fg">{formatCOP(totals.total)}</div>
              <div className="text-[12px] text-dim">
                Subtotal {formatCOP(totals.subtotal)} · IVA {formatCOP(totals.tax)}
              </div>
            </div>

            <div>
              <div className={`${labelCls} mb-1.5`}>Medio de pago</div>
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_METHODS.map((m) => {
                  const off = m.id === "epayco" && !epaycoReady;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setMethod(m.id)}
                      disabled={off}
                      title={off ? "No disponible: falta configurar ePayco" : undefined}
                      className={`min-h-12 px-2 rounded-lg border text-[14px] font-medium leading-tight disabled:opacity-50 disabled:cursor-not-allowed ${
                        method === m.id ? "bg-brand border-brand text-white" : "bg-surface border-field text-body hover:bg-hover"
                      } ${m.id === "epayco" ? "col-span-2" : ""}`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {isEpayco && (
              <div className="rounded-lg border border-brand-line bg-brand-soft px-3 py-3 text-[14px] text-brand-ink space-y-1">
                <div className="font-bold">Cobro con tarjeta, PSE, Nequi, etc.</div>
                <div>
                  Al confirmar se abre la ventana de ePayco para que el cliente pague. La venta solo se factura cuando el
                  servidor confirma el pago con ePayco; no hace falta digitar ninguna referencia.
                </div>
              </div>
            )}

            {needsRef && (
              <div className="space-y-3">
                <label className="block">
                  <span className={labelCls}>Referencia o últimos dígitos del comprobante</span>
                  <input
                    className={inputCls}
                    autoFocus={autoFocusFields}
                    maxLength={60}
                    inputMode="numeric"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Ej. 4821 o número de aprobación"
                  />
                </label>
                <label
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer text-[14px] text-fg ${
                    verified ? "bg-ok-soft border-ok-line" : "bg-surface border-warn-line"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 w-6 h-6 shrink-0"
                    checked={verified}
                    onChange={(e) => setVerified(e.target.checked)}
                  />
                  <span>Verifiqué el pago en el datáfono o en la cuenta de FECP</span>
                </label>

                {receiptOk && (
                  <div className={`rounded-lg border px-3 py-2.5 space-y-2 ${receiptMust && !receipt ? "border-warn-line bg-warn-soft" : "border-line bg-subtle"}`}>
                    <div className="text-[13px] font-semibold text-body">
                      Comprobante {receiptMust ? <span className="text-err-ink">(obligatorio)</span> : <span className="text-dim font-normal">(opcional)</span>}
                    </div>
                    {receipt && receiptUrl ? (
                      <div className="flex items-center gap-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={receiptUrl} alt="Comprobante" className="w-20 h-20 object-cover rounded-md border border-line bg-white" />
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => setCamOpen(true)} className="px-3 min-h-11 rounded-lg border border-field text-[13px] font-medium text-body bg-surface">Cambiar foto</button>
                          <button onClick={() => setReceipt(null)} className="px-3 min-h-11 rounded-lg border border-field text-[13px] font-medium text-body bg-surface">Quitar</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setCamOpen(true)} className="w-full px-4 min-h-12 rounded-lg border border-brand text-brand-text bg-surface text-[15px] font-semibold hover:bg-brand-soft">
                        Tomar foto del comprobante
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {method === "efectivo" && (
              <div className="space-y-2">
                <label className="block">
                  <span className={labelCls}>Valor recibido</span>
                  <input
                    className={`${inputCls} !text-xl font-bold`}
                    inputMode="numeric"
                    autoFocus={autoFocusFields}
                    value={cash ? formatCOP(cash) : ""}
                    onChange={(e) => setCashStr(e.target.value)}
                    placeholder="$ 0"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {QUICK_BILLS.map((b) => (
                    <button key={b} onClick={() => setCashStr(String(b))} className="min-h-11 rounded-lg border border-field bg-surface text-[14px] font-medium text-body hover:bg-hover">
                      {formatCOP(b)}
                    </button>
                  ))}
                  <button
                    onClick={() => setCashStr(String(Math.ceil(totals.total)))}
                    className="min-h-11 rounded-lg border border-brand text-brand-text bg-surface text-[14px] font-semibold hover:bg-brand-soft"
                  >
                    Exacto
                  </button>
                </div>
                <div className={`rounded-xl text-center py-3 ${change >= 0 && cash > 0 ? "bg-ok-soft" : "bg-surface border border-line"}`}>
                  <div className="text-[13px] font-semibold text-body">{change < 0 && cash > 0 ? "Faltan" : "Cambio"}</div>
                  <div className={`text-4xl sm:text-5xl font-extrabold ${change < 0 && cash > 0 ? "text-err-ink" : "text-ok-ink"}`}>
                    {cash > 0 ? formatCOP(Math.abs(change)) : "$ 0"}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {camOpen && (
          <ReceiptCapture
            title={receiptMust ? "Foto del comprobante de la transferencia" : "Foto del voucher del datáfono"}
            onCancel={() => setCamOpen(false)}
            onAccept={(b) => {
              setReceipt(b);
              setCamOpen(false);
            }}
          />
        )}

        {/* Pie siempre visible (no se va con el scroll del contenido) */}
        <div className="px-4 sm:px-6 py-3 border-t border-line flex flex-wrap items-center gap-3 shrink-0">
          <div className="w-full sm:flex-1 sm:w-auto text-[13px] text-err-ink sm:min-h-5 empty:hidden">{error}</div>
          <button onClick={onClose} className="px-5 min-h-12 rounded-lg border border-field text-[14px] font-medium text-body">
            Cancelar<span className="hidden md:inline"> (Esc)</span>
          </button>
          <button
            onClick={confirm}
            disabled={!!error || busy}
            className="flex-1 sm:flex-none px-6 sm:px-8 min-h-12 rounded-lg bg-go hover:bg-go-hover text-white text-lg font-bold disabled:opacity-50"
          >
            {busy ? "Registrando…" : isEpayco ? "Cobrar con ePayco" : "Confirmar venta"}
            <span className="hidden md:inline"> (F9)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
