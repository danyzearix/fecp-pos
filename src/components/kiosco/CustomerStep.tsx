"use client";

import { DEPTS, citiesOf, nitDv, type CustomerFormState } from "@/lib/client/customer-form";
import { ID_TYPES } from "@/lib/sale-types";
import { formatCOP } from "@/lib/money";

type Props = {
  /** cf = Consumidor final · existing = "Sí, soy yo" (sus datos guardados NO se muestran ni se prellenan) · new = cliente nuevo, formulario en blanco */
  mode: "cf" | "existing" | "new";
  form: CustomerFormState;
  setForm: (f: CustomerFormState) => void;
  error: string;
  busy: boolean;
  total: number;
  onBack: () => void;
  onNext: () => void;
};

const input =
  "mt-1 w-full border border-field rounded-xl px-4 py-3.5 text-xl text-fg placeholder:text-xl placeholder:text-faint outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 bg-surface";
const label = "block text-[16px] font-semibold text-body";

/**
 * Paso de contacto / datos. NUNCA se prellena con datos guardados (privacidad): el teléfono y el correo (para ePayco y para enviar la
 * factura) los escribe la persona; solo un cliente NUEVO llena además los datos de su factura, en blanco.
 */
export default function CustomerStep(p: Props) {
  const f = p.form;
  const set = (patch: Partial<CustomerFormState>) => p.setForm({ ...f, ...patch });
  const isNit = f.idType === "31";

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-fg">{p.mode === "new" ? "Sus datos para la factura" : "Sus datos de contacto"}</h1>
          <p className="text-[17px] text-soft mt-1">
            Total a pagar: <b className="text-fg">{formatCOP(p.total)}</b>
          </p>
        </div>

        <div className="rounded-xl px-5 py-4 text-[16px] bg-brand-soft border border-brand-line text-brand-ink">
          {p.mode === "cf" && (
            <>
              La factura se hace como <b>Consumidor final</b>. Si quiere recibirla por correo, escríbalo (es opcional).
            </>
          )}
          {p.mode === "existing" && <>Escriba su correo para recibir la factura (es opcional). Sus datos guardados no se muestran en esta pantalla.</>}
          {p.mode === "new" && (
            <>
              No encontramos su cédula: escriba todos los datos de la <b>factura electrónica</b> a su nombre.
            </>
          )}
        </div>

        {p.mode !== "new" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
            <label>
              <span className={label}>Correo para recibir la factura (opcional)</span>
              <input className={input} type="email" autoComplete="off" value={f.email} onChange={(e) => set({ email: e.target.value })} placeholder="correo@ejemplo.com" />
            </label>
            <label>
              <span className={label}>Teléfono (opcional)</span>
              <input className={input} inputMode="tel" autoComplete="off" value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Teléfono" />
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-4 sm:gap-5">
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Tipo de documento</span>
              <select className={input} value={f.idType} onChange={(e) => set({ idType: e.target.value, dv: e.target.value === "31" ? nitDv(f.identification) : "" })}>
                {ID_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </label>
            <label className={isNit ? "col-span-1 sm:col-span-2" : "col-span-2 sm:col-span-3"}>
              <span className={label}>Número{isNit ? " (sin dígito de verificación)" : ""}</span>
              <input className={input + " bg-subtle"} inputMode="numeric" value={f.identification} readOnly />
            </label>
            {isNit && (
              <label>
                <span className={label}>DV</span>
                <input className={input} maxLength={1} inputMode="numeric" value={f.dv} onChange={(e) => set({ dv: e.target.value.replace(/\D/g, "") })} />
              </label>
            )}
            {isNit ? (
              <label className="col-span-2 sm:col-span-6">
                <span className={label}>Razón social</span>
                <input className={input} autoComplete="off" value={f.company} onChange={(e) => set({ company: e.target.value })} placeholder="Razón social" />
              </label>
            ) : (
              <>
                <label className="col-span-2 sm:col-span-3">
                  <span className={label}>Nombres</span>
                  <input className={input} autoComplete="off" value={f.first} onChange={(e) => set({ first: e.target.value })} placeholder="Nombres" />
                </label>
                <label className="col-span-2 sm:col-span-3">
                  <span className={label}>Apellidos</span>
                  <input className={input} autoComplete="off" value={f.last} onChange={(e) => set({ last: e.target.value })} placeholder="Apellidos" />
                </label>
              </>
            )}
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Correo</span>
              <input className={input} type="email" autoComplete="off" value={f.email} onChange={(e) => set({ email: e.target.value })} placeholder="correo@ejemplo.com" />
            </label>
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Teléfono (opcional)</span>
              <input className={input} inputMode="tel" autoComplete="off" value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Teléfono" />
            </label>
            <label className="col-span-2 sm:col-span-6">
              <span className={label}>Dirección</span>
              <input className={input} autoComplete="off" value={f.address} onChange={(e) => set({ address: e.target.value })} placeholder="Dirección" />
            </label>
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Departamento</span>
              <select
                className={input}
                value={f.state}
                onChange={(e) => {
                  const first = citiesOf(e.target.value)[0];
                  set({ state: e.target.value, city: first ? first[0] : "" });
                }}
              >
                <option value="">Seleccionar…</option>
                {DEPTS.map((d) => (
                  <option key={d.code} value={d.code}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Ciudad</span>
              <select className={input} value={f.city} onChange={(e) => set({ city: e.target.value })}>
                <option value="">Seleccionar…</option>
                {citiesOf(f.state).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {p.error && <p className="text-[17px] text-err-ink bg-err-soft rounded-xl p-4">{p.error}</p>}

        <div className="flex gap-4 pt-2">
          <button onClick={p.onBack} className="px-8 py-4 rounded-xl border border-field text-xl font-medium text-body bg-surface">
            ← Volver
          </button>
          <button onClick={p.onNext} disabled={p.busy} className="flex-1 py-4 min-h-16 rounded-xl bg-go hover:bg-go-hover text-white text-2xl font-bold disabled:opacity-60">
            {p.busy ? "Preparando el pago…" : `Continuar al pago · ${formatCOP(p.total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
