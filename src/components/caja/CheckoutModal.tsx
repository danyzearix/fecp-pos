"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReceiptCapture from "@/components/ReceiptCapture";
import { receiptAllowed, receiptRequired } from "@/lib/receipt-rules";
import { bogotaDay, validatePaymentLines, type PayLineIn } from "@/lib/payment-lines";
import { DEPTS, citiesOf, EMAIL_RE, nitDv } from "@/lib/client/customer-form";
import { finePointer } from "@/lib/client/pointer";
import { formatCOP } from "@/lib/money";
import { MISSING_LABEL, type MissingField } from "@/lib/customer-rules";
import type { CajaCustomerView } from "@/lib/customer-lookup";
import { CONSUMIDOR_FINAL_ID, ID_TYPES, ID_TYPE_LABELS, paymentShortLabel, type CustomerIn, type PaymentMethod, type PosConfig } from "@/lib/sale-types";
import PaymentLines from "./PaymentLines";
import { newLine, toPayLinesIn, type LineUi } from "./payment-ui";

export type CheckoutResult = {
  /** "completo" = cliente identificado (cédula/NIT); "corto" = Consumidor final */
  checkoutType: "corto" | "completo";
  customer: CustomerIn | null;
  /** "epayco" (flujo aparte), el medio de la única línea, o "mixto" */
  paymentMethod: PaymentMethod;
  /** líneas de pago (1 a 4, una por medio). Vacío si es pago electrónico (ePayco). */
  payments: PayLineIn[];
  /** foto del comprobante (ya reducida). Obligatoria con transferencia, opcional con tarjeta; null si no aplica. */
  receipt: Blob | null;
};

type Props = {
  totals: { subtotal: number; tax: number; total: number };
  config: PosConfig;
  /** ¿Está lista la configuración de ePayco (llaves + facturación)? Si no, el botón queda deshabilitado */
  epaycoReady: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (r: CheckoutResult) => void;
};

type Form = {
  idType: string; identification: string; dv: string; company: string;
  first: string; last: string;
  email: string; phone: string; address: string; state: string; city: string;
};

/** Cliente elegido en el paso 1 */
type Choice =
  | { kind: "cf" }
  | { kind: "existing"; view: CajaCustomerView; fill: Form }
  | { kind: "new"; form: Form };

type Phase = "input" | "searching" | "found" | "notfound" | "form";

const inputCls =
  "w-full border border-field rounded-lg px-3 py-2 min-h-12 text-[16px] text-fg placeholder:text-[15px] placeholder:text-faint outline-none focus:border-brand bg-surface";
const labelCls = "block text-[13px] font-semibold text-body";
const bigBtn = "px-5 min-h-14 rounded-xl text-[17px] font-bold";

const ID_FORMAT = /^[0-9A-Za-z-]{3,20}$/;

export default function CheckoutModal({ totals, config, epaycoReady, busy, onClose, onConfirm }: Props) {
  const threshold = 5 * config.uvt;
  // Con CONSUMIDOR_FINAL_SIN_TOPE=false se conserva el tope anterior: por encima de 5 UVT (base sin IVA) hay que identificar al cliente
  const capRequired = !config.consumidorFinalSinTope && totals.subtotal > threshold;

  // ---- Paso 1: cliente · Paso 2: pago ----
  const [step, setStep] = useState<"id" | "pay">("id");
  const [phase, setPhase] = useState<Phase>("input");
  const [idType, setIdType] = useState("13");
  const [idNumber, setIdNumber] = useState("");
  const [notice, setNotice] = useState("");
  const [found, setFound] = useState<CajaCustomerView | null>(null);
  const emptyForm = (): Form => ({
    idType, identification: idNumber.trim(), dv: "", company: "", first: "", last: "",
    email: "", phone: "", address: "", state: config.defaultStateCode, city: config.defaultCityCode,
  });
  const [f, setF] = useState<Form>(() => ({
    idType: "13", identification: "", dv: "", company: "", first: "", last: "", email: "", phone: "", address: "",
    state: config.defaultStateCode, city: config.defaultCityCode,
  }));
  const set = (k: keyof Form, v: string) => setF((p) => ({ ...p, [k]: v }));
  const [choice, setChoice] = useState<Choice | null>(null);
  const seq = useRef(0);

  // Líneas de pago (cobro dividido). Empieza con una línea de efectivo que cubre el total.
  const [lines, setLines] = useState<LineUi[]>(() => [newLine("efectivo")]);
  const hasCredit = lines.some((l) => l.method === "credito_fecp");

  const isEpayco = lines.length === 1 && lines[0].method === "epayco"; // el pago lo verifica el servidor con ePayco: no hay referencia ni casilla
  const methods = lines.map((l) => l.method);
  const saleDay = bogotaDay(new Date());
  // Comprobante (evidencia para auditoría): NO reemplaza la referencia ni la casilla
  const [receipt, setReceipt] = useState<Blob | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const receiptUrl = useMemo(() => (receipt ? URL.createObjectURL(receipt) : null), [receipt]);
  useEffect(() => () => {
    if (receiptUrl) URL.revokeObjectURL(receiptUrl);
  }, [receiptUrl]);
  const receiptOk = receiptAllowed(methods); // transferencia (obligatorio) o tarjeta (opcional)
  const receiptMust = receiptRequired(methods); // basta UNA línea de transferencia
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

  const cities = useMemo(() => citiesOf(f.state), [f.state]);
  const isNit = f.idType === "31";
  // NIT: calcular el dígito de verificación automáticamente (se puede corregir a mano)
  useEffect(() => {
    if (phase === "form" && f.idType === "31") setF((p) => ({ ...p, dv: nitDv(p.identification) }));
  }, [phase, f.idType, f.identification]);

  // ------------------------------------------------------------------ paso 1: buscar
  async function search() {
    const id = idNumber.trim();
    setNotice("");
    if (!online) return setNotice("Sin conexión: no se puede buscar al cliente. Puedes usar Consumidor final o facturar escribiendo sus datos.");
    if (id === CONSUMIDOR_FINAL_ID) return setNotice("Para Consumidor final usa el botón de abajo.");
    if (!ID_FORMAT.test(id)) return setNotice("Escribe el número de documento completo (solo letras y números, sin puntos).");
    const mine = ++seq.current;
    setPhase("searching");
    try {
      const res = await fetch(`/api/customers?identification=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as { found?: boolean; customer?: CajaCustomerView; notice?: string; error?: string };
      if (mine !== seq.current) return;
      if (!res.ok) {
        setPhase("input");
        return setNotice(d.error ?? "No se pudo consultar al cliente. Intenta de nuevo.");
      }
      if (d.found && d.customer) {
        setFound(d.customer);
        setF({ ...emptyForm(), idType: d.customer.id_type, identification: d.customer.identification, dv: d.customer.id_type === "31" ? nitDv(d.customer.identification) : "" });
        setPhase("found");
      } else {
        setFound(null);
        setNotice(d.notice ?? "");
        setPhase("notfound");
      }
    } catch {
      if (mine !== seq.current) return;
      setPhase("input");
      setNotice("Sin conexión con el servidor. Puedes usar Consumidor final o facturar escribiendo los datos del cliente.");
    }
  }

  function goForm() {
    const id = idNumber.trim();
    setF({ ...emptyForm(), idType, identification: id, dv: idType === "31" ? nitDv(id) : "" });
    setPhase("form");
  }
  function useConsumidorFinal() {
    if (capRequired) return;
    setChoice({ kind: "cf" });
    setStep("pay");
  }
  function backToId(msg = "") {
    seq.current++;
    setStep("id");
    setPhase("input");
    setFound(null);
    setChoice(null);
    setNotice(msg);
  }

  // Cliente que ya existe: solo se piden los datos que le faltan (los demás no se tocan)
  const missing: MissingField[] = found?.missing ?? [];
  function foundError(): string | null {
    for (const m of missing) {
      if (m === "company" && !f.company.trim()) return "Escribe la razón social";
      if (m === "first" && !f.first.trim()) return "Escribe los nombres";
      if (m === "last" && !f.last.trim()) return "Escribe los apellidos";
      if (m === "dv" && !/^\d$/.test(f.dv)) return "Falta el dígito de verificación";
      if (m === "email" && !EMAIL_RE.test(f.email.trim())) return "Escribe un correo válido";
      if (m === "address" && !f.address.trim()) return "Escribe la dirección";
      if (m === "state" && !f.state) return "Selecciona el departamento";
      if (m === "city" && !f.city) return "Selecciona la ciudad";
    }
    return null;
  }
  function useExisting() {
    if (!found || foundError()) return;
    setChoice({ kind: "existing", view: found, fill: f });
    setStep("pay");
  }

  // Cliente nuevo (o sin conexión): formulario completo en blanco
  function formError(): string | null {
    const id = f.identification.trim();
    if (!id) return "Escribe el número de documento";
    if (id === CONSUMIDOR_FINAL_ID) return "Para Consumidor final usa el botón de abajo";
    if (!ID_FORMAT.test(id)) return "El número de documento solo puede tener letras y números";
    if (f.idType === "31") {
      if (!/^\d{5,15}$/.test(id)) return "El NIT debe tener solo números";
      if (!/^\d$/.test(f.dv)) return "Falta el dígito de verificación";
      if (!f.company.trim()) return "Escribe la razón social";
    } else if (!f.first.trim() || !f.last.trim()) return "Escribe nombres y apellidos";
    if (!EMAIL_RE.test(f.email.trim())) return "Escribe un correo válido";
    if (!f.address.trim()) return "Escribe la dirección";
    if (!f.state || !f.city) return "Selecciona departamento y ciudad";
    return null;
  }
  function useNew() {
    if (formError()) return;
    setChoice({ kind: "new", form: f });
    setStep("pay");
  }

  // El Crédito FECP exige un cliente identificado: si el actual es Consumidor final se vuelve al paso de identificación
  useEffect(() => {
    if (step === "pay" && hasCredit && choice?.kind === "cf") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      backToId("El Crédito FECP exige un cliente identificado con cédula o NIT. Identifica al cliente para continuar.");
    }
  }, [step, hasCredit, choice]);

  // ------------------------------------------------------------------ cliente de la venta
  const customerIdType = choice?.kind === "existing" ? choice.view.id_type : choice?.kind === "new" ? choice.form.idType : "";
  const identified = choice?.kind === "existing" || choice?.kind === "new";
  const checkoutType: "corto" | "completo" = identified ? "completo" : "corto";

  function buildCustomer(): CustomerIn | null {
    if (!choice || choice.kind === "cf") return null;
    if (choice.kind === "existing") {
      // Solo el tipo y el número del cliente que ya existe, más los datos que faltaban (el servidor completa solo campos vacíos)
      const x = choice.fill;
      const c: CustomerIn = { display_name: choice.view.name, id_type: choice.view.id_type, identification: choice.view.identification };
      if (missing.includes("company")) c.company_name = x.company.trim();
      if (missing.includes("first")) c.first_name = x.first.trim();
      if (missing.includes("last")) c.last_name = x.last.trim();
      if (missing.includes("dv")) c.check_digit = x.dv;
      if (missing.includes("email")) c.email = x.email.trim();
      if (missing.includes("address")) c.address = x.address.trim();
      if (missing.includes("state")) c.state_code = x.state;
      if (missing.includes("city")) c.city_code = x.city;
      return c;
    }
    const x = choice.form;
    const nit = x.idType === "31";
    return {
      display_name: nit ? x.company.trim() : [x.first.trim(), x.last.trim()].filter(Boolean).join(" "),
      id_type: x.idType,
      identification: x.identification.trim(),
      check_digit: nit ? x.dv : "",
      company_name: nit ? x.company.trim() : "",
      first_name: nit ? "" : x.first.trim(),
      last_name: nit ? "" : x.last.trim(),
      email: x.email.trim(),
      phone: x.phone.trim(),
      address: x.address.trim(),
      state_code: x.state,
      city_code: x.city,
    };
  }

  // ------------------------------------------------------------------ paso 2: validación y confirmación
  function validate(): string | null {
    if (!choice) return "Identifica al cliente";
    if (isEpayco && !epaycoReady) return "El pago electrónico no está disponible (revise la configuración de ePayco)";
    if (isEpayco && !online) return "Sin conexión: el pago electrónico necesita internet";
    if (!isEpayco) {
      // Crédito FECP: cédula o NIT REALES (no Consumidor final, ni pasaporte)
      if (hasCredit && (!identified || !["13", "22", "31"].includes(customerIdType))) return "El Crédito FECP exige un cliente identificado con cédula o NIT";
      // La misma validación que hace el servidor (src/lib/payment-lines.ts), con el total de esta venta
      const v = validatePaymentLines(toPayLinesIn(lines, totals.total), totals.total, { saleDay, customerIdentified: identified });
      if (!v.ok) return v.error;
      const unverified = lines.find((l) => (l.method === "tarjeta" || l.method === "transferencia") && !l.verified);
      if (unverified) return `Marca la casilla de ${paymentShortLabel(unverified.method)}: verificaste el pago en el datáfono o en la cuenta`;
      if (receiptMust && !receipt) return "Toma la foto del comprobante (obligatoria cuando hay transferencia)";
    }
    return null;
  }
  const error = step === "pay" ? validate() : null;

  function confirm() {
    if (busy || error || step !== "pay") return;
    onConfirm({
      checkoutType,
      customer: buildCustomer(),
      paymentMethod: isEpayco ? "epayco" : lines.length > 1 ? "mixto" : lines[0].method,
      payments: isEpayco ? [] : toPayLinesIn(lines, totals.total),
      receipt: receiptOk && !isEpayco ? receipt : null,
    });
  }

  // Atajos del modal: Esc cierra. F9: en el paso de identificación abre directo el formulario "factura a nombre del cliente";
  // en el paso de pago confirma la venta (como siempre).
  const camOpenRef = useRef(false);
  useEffect(() => {
    camOpenRef.current = camOpen;
  }, [camOpen]);
  const confirmRef = useRef(confirm);
  const goFormRef = useRef(goForm);
  const stepRef = useRef(step);
  useEffect(() => {
    confirmRef.current = confirm;
    goFormRef.current = goForm;
    stepRef.current = step;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (camOpenRef.current) return; // la cámara está abierta: ella maneja sus teclas
      if (e.key === "F9") {
        e.preventDefault();
        if (stepRef.current === "pay") confirmRef.current();
        else goFormRef.current();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ------------------------------------------------------------------ piezas de formulario
  const deptSelect = (
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
  );
  const citySelect = (
    <label className="col-span-2 sm:col-span-3">
      <span className={labelCls}>Ciudad</span>
      <select className={inputCls} value={f.city} onChange={(e) => set("city", e.target.value)}>
        <option value="">Seleccionar…</option>
        {cities.map(([code, name]) => (
          <option key={code} value={code}>{name}</option>
        ))}
      </select>
    </label>
  );
  const consumidorFinalBtn = (
    <button
      type="button"
      onClick={useConsumidorFinal}
      disabled={capRequired}
      className={`${bigBtn} border-2 border-field bg-surface text-body hover:bg-hover disabled:opacity-50 w-full`}
    >
      Consumidor final
    </button>
  );
  const capNote = capRequired && (
    <p className="text-[13px] text-warn-ink bg-warn-soft border border-warn-line rounded-lg px-3 py-2">
      La base sin IVA ({formatCOP(totals.subtotal)}) supera 5 UVT ({formatCOP(threshold)}): hay que identificar al cliente (CONSUMIDOR_FINAL_SIN_TOPE=false).
    </p>
  );

  // ------------------------------------------------------------------ resumen del cliente (paso 2)
  const summary = (() => {
    if (!choice) return null;
    if (choice.kind === "cf") return { name: "Consumidor final", doc: `${ID_TYPE_LABELS["13"]} ${CONSUMIDOR_FINAL_ID}`, extra: "" };
    if (choice.kind === "existing")
      return {
        name: choice.view.name,
        doc: `${choice.view.id_type_label} ${choice.view.identification}`,
        extra: [choice.view.email_masked, choice.view.phone_masked].filter(Boolean).join(" · "),
      };
    const nit = choice.form.idType === "31";
    return {
      name: nit ? choice.form.company : `${choice.form.first} ${choice.form.last}`,
      doc: `${ID_TYPE_LABELS[choice.form.idType] ?? choice.form.idType} ${choice.form.identification}`,
      extra: "Cliente nuevo: se crea en Siigo al facturar",
    };
  })();

  return (
    // En celular y tablet vertical ocupa toda la pantalla; desde lg vuelve a ser una ventana centrada
    <div className="fixed inset-0 z-40 bg-black/50 flex items-stretch lg:items-center justify-center lg:p-4">
      <div className="bg-surface shadow-2xl w-full h-full lg:h-auto lg:rounded-2xl lg:max-w-245 lg:max-h-[94vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-line shrink-0">
          <h2 className="text-lg font-bold text-fg">
            Cobrar venta <span className="text-[13px] font-medium text-dim">· paso {step === "id" ? "1 de 2: cliente" : "2 de 2: pago"}</span>
          </h2>
          <button onClick={onClose} className="w-11 h-11 rounded-lg text-2xl leading-none text-dim hover:text-fg hover:bg-hover" title="Cerrar (Esc)" aria-label="Cerrar">
            ×
          </button>
        </div>

        {step === "id" ? (
          // ================= PASO 1: IDENTIFICAR AL CLIENTE =================
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
            <div className="max-w-xl mx-auto space-y-4">
              <div className="text-center">
                <div className="text-[13px] font-semibold text-body">Total a pagar</div>
                <div className="text-3xl font-extrabold text-fg">{formatCOP(totals.total)}</div>
              </div>

              {(phase === "input" || phase === "searching") && (
                <>
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void search();
                    }}
                  >
                    <div className="grid grid-cols-3 gap-3">
                      <label className="col-span-3 sm:col-span-1">
                        <span className={labelCls}>Tipo de documento</span>
                        <select className={inputCls} value={idType} onChange={(e) => setIdType(e.target.value)}>
                          {ID_TYPES.map((t) => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="col-span-3 sm:col-span-2">
                        <span className={labelCls}>Número de documento{idType === "31" ? " (NIT sin dígito de verificación)" : ""}</span>
                        <input
                          className={inputCls}
                          inputMode="numeric"
                          autoFocus={autoFocusFields}
                          autoComplete="off"
                          value={idNumber}
                          onChange={(e) => setIdNumber(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))}
                          placeholder="Escribe el número y pulsa Enter"
                        />
                      </label>
                    </div>
                    <button
                      type="submit"
                      disabled={phase === "searching" || !online || !idNumber.trim()}
                      className={`${bigBtn} w-full bg-brand text-white disabled:opacity-50`}
                    >
                      {phase === "searching" ? "Buscando…" : "Buscar cliente"}
                    </button>
                  </form>
                  {!online && (
                    <p className="text-[13px] text-warn-ink bg-warn-soft border border-warn-line rounded-lg px-3 py-2">
                      Sin conexión: no se puede buscar al cliente. Puedes usar Consumidor final o facturar a nombre del cliente escribiendo sus datos; la venta se guarda y se envía cuando vuelva internet.
                    </p>
                  )}
                  {notice && <p className="text-[14px] text-err-ink bg-err-soft rounded-lg px-3 py-2" role="alert">{notice}</p>}
                  {capNote}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    {consumidorFinalBtn}
                    <button type="button" onClick={goForm} className={`${bigBtn} w-full border-2 border-brand text-brand-text bg-surface hover:bg-brand-soft`}>
                      Factura a nombre del cliente<span className="hidden md:inline"> (F9)</span>
                    </button>
                  </div>
                </>
              )}

              {phase === "found" && found && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-ok-line bg-ok-soft px-4 py-3">
                    <div className="text-[12px] font-semibold text-ok-ink">✓ Cliente encontrado</div>
                    <div className="text-[20px] font-bold text-fg leading-tight">{found.name}</div>
                    <div className="text-[15px] text-body">
                      {found.id_type_label} <b>{found.identification}</b>
                      {found.check_digit ? `-${found.check_digit}` : ""}
                    </div>
                    <div className="text-[14px] text-dim mt-1">
                      Correo: {found.email_masked || "—"} · Teléfono: {found.phone_masked || "—"}
                    </div>
                  </div>
                  {missing.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-[14px] text-warn-ink bg-warn-soft border border-warn-line rounded-lg px-3 py-2">
                        Para facturar a este cliente faltan: <b>{missing.map((m) => MISSING_LABEL[m]).join(", ")}</b>. Escríbelos; los demás datos no se tocan.
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                        {missing.includes("company") && (
                          <label className="col-span-2 sm:col-span-6">
                            <span className={labelCls}>Razón social</span>
                            <input className={inputCls} value={f.company} onChange={(e) => set("company", e.target.value)} />
                          </label>
                        )}
                        {missing.includes("first") && (
                          <label className="col-span-2 sm:col-span-3">
                            <span className={labelCls}>Nombres</span>
                            <input className={inputCls} value={f.first} onChange={(e) => set("first", e.target.value)} />
                          </label>
                        )}
                        {missing.includes("last") && (
                          <label className="col-span-2 sm:col-span-3">
                            <span className={labelCls}>Apellidos</span>
                            <input className={inputCls} value={f.last} onChange={(e) => set("last", e.target.value)} />
                          </label>
                        )}
                        {missing.includes("dv") && (
                          <label className="col-span-1 sm:col-span-2">
                            <span className={labelCls}>Dígito de verificación</span>
                            <input className={inputCls} maxLength={1} inputMode="numeric" value={f.dv} onChange={(e) => set("dv", e.target.value.replace(/\D/g, ""))} />
                          </label>
                        )}
                        {missing.includes("email") && (
                          <label className="col-span-2 sm:col-span-6">
                            <span className={labelCls}>Correo</span>
                            <input className={inputCls} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="correo@ejemplo.com" />
                          </label>
                        )}
                        {missing.includes("address") && (
                          <label className="col-span-2 sm:col-span-6">
                            <span className={labelCls}>Dirección</span>
                            <input className={inputCls} value={f.address} onChange={(e) => set("address", e.target.value)} />
                          </label>
                        )}
                        {(missing.includes("state") || missing.includes("city")) && (
                          <>
                            {deptSelect}
                            {citySelect}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {foundError() && <p className="text-[13px] text-err-ink">{foundError()}</p>}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <button type="button" onClick={() => backToId()} className={`${bigBtn} border border-field text-body bg-surface sm:w-48`}>
                      Otro cliente
                    </button>
                    <button type="button" onClick={useExisting} disabled={!!foundError()} className={`${bigBtn} flex-1 bg-go hover:bg-go-hover text-white disabled:opacity-50`}>
                      Facturar a este cliente
                    </button>
                  </div>
                </div>
              )}

              {phase === "notfound" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-line bg-subtle px-4 py-3 text-center">
                    <div className="text-[16px] font-bold text-fg">No encontramos al cliente {idNumber.trim()}</div>
                    {notice && <div className="text-[13px] text-dim mt-0.5">{notice}</div>}
                  </div>
                  {capNote}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {consumidorFinalBtn}
                    <button type="button" onClick={goForm} className={`${bigBtn} w-full bg-brand text-white`}>
                      Factura electrónica a nombre del cliente
                    </button>
                  </div>
                  <button type="button" onClick={() => backToId()} className="min-h-11 px-3 text-[14px] text-brand-text underline">
                    ← Buscar otro número
                  </button>
                </div>
              )}

              {phase === "form" && (
                <div className="space-y-4">
                  <p className="text-[14px] text-body bg-brand-soft border border-brand-line rounded-lg px-3 py-2">
                    Factura electrónica a nombre del cliente. Si no existe en Siigo, se crea al facturar.
                  </p>
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
                      <input className={inputCls} inputMode="numeric" value={f.identification} onChange={(e) => set("identification", e.target.value.replace(/[^0-9A-Za-z-]/g, ""))} />
                    </label>
                    {isNit && (
                      <label>
                        <span className={labelCls}>DV</span>
                        <input className={inputCls} maxLength={1} inputMode="numeric" value={f.dv} onChange={(e) => set("dv", e.target.value.replace(/\D/g, ""))} />
                      </label>
                    )}
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
                      <span className={labelCls}>Teléfono (opcional)</span>
                      <input className={inputCls} inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="Teléfono" />
                    </label>
                    <label className="col-span-2 sm:col-span-6">
                      <span className={labelCls}>Dirección</span>
                      <input className={inputCls} value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="Dirección" />
                    </label>
                    {deptSelect}
                    {citySelect}
                  </div>
                  {formError() && <p className="text-[13px] text-err-ink">{formError()}</p>}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <button type="button" onClick={() => backToId()} className={`${bigBtn} border border-field text-body bg-surface sm:w-48`}>
                      ← Volver
                    </button>
                    <button type="button" onClick={useNew} disabled={!!formError()} className={`${bigBtn} flex-1 bg-go hover:bg-go-hover text-white disabled:opacity-50`}>
                      Continuar al pago
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          // ================= PASO 2: PAGO =================
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_1.25fr] overflow-y-auto lg:overflow-hidden">
            {/* ---------- Izquierda: cliente elegido ---------- */}
            <div className="p-4 sm:p-6 lg:overflow-y-auto space-y-3 border-b lg:border-b-0 lg:border-r border-line">
              <div className={labelCls}>Cliente de la factura</div>
              {summary && (
                <div className="rounded-xl border border-line bg-subtle px-4 py-3">
                  <div className="text-[18px] font-bold text-fg leading-tight">{summary.name}</div>
                  <div className="text-[14px] text-body">{summary.doc}</div>
                  {summary.extra && <div className="text-[13px] text-dim mt-0.5">{summary.extra}</div>}
                </div>
              )}
              <button type="button" onClick={() => backToId()} className="min-h-11 px-4 rounded-lg border border-field text-[14px] font-medium text-body bg-surface">
                Cambiar cliente
              </button>
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

              {/* Medios de pago: una línea por medio (máx. 4). El servidor valida todo otra vez. */}
              <PaymentLines total={totals.total} lines={lines} setLines={setLines} epaycoReady={epaycoReady} saleDay={saleDay} autoFocus={autoFocusFields} />

              {/* Comprobante (evidencia): obligatorio con transferencia, opcional con tarjeta. NO reemplaza referencia ni casilla. */}
              {receiptOk && !isEpayco && (
                <div className={`rounded-lg border px-3 py-2.5 space-y-2 ${receiptMust && !receipt ? "border-warn-line bg-warn-soft" : "border-line bg-subtle"}`}>
                  <div className="text-[13px] font-semibold text-body">
                    Comprobante {receiptMust ? <span className="text-err-ink">(obligatorio por la transferencia)</span> : <span className="text-dim font-normal">(opcional)</span>}
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
          </div>
        )}

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
          {step === "pay" && (
            <button
              onClick={confirm}
              disabled={!!error || busy}
              className="flex-1 sm:flex-none px-6 sm:px-8 min-h-12 rounded-lg bg-go hover:bg-go-hover text-white text-lg font-bold disabled:opacity-50"
            >
              {busy ? "Registrando…" : isEpayco ? "Cobrar con ePayco" : "Confirmar venta"}
              <span className="hidden md:inline"> (F9)</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
