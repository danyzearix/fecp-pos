"use client";

import { DEPTS, citiesOf, nitDv, type CustomerFormState } from "@/lib/client/customer-form";
import { ID_TYPES } from "@/lib/sale-types";
import { formatCOP } from "@/lib/money";

type Props = {
  form: CustomerFormState;
  setForm: (f: CustomerFormState) => void;
  type: "corto" | "completo";
  forceFull: boolean;
  threshold: number;
  base: number;
  total: number;
  manualFull: boolean;
  setManualFull: (v: boolean) => void;
  error: string;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
};

const input =
  "mt-1 w-full border border-field rounded-xl px-4 py-3.5 text-xl text-fg placeholder:text-xl placeholder:text-faint outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 bg-surface";
const label = "block text-[16px] font-semibold text-body";

/** Paso de datos del cliente. SIN autocompletar y sin consultar clientes guardados (privacidad). */
export default function CustomerStep(p: Props) {
  const f = p.form;
  const set = (patch: Partial<CustomerFormState>) => p.setForm({ ...f, ...patch });
  const isNit = f.idType === "31";

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-fg">Sus datos para la factura</h1>
          <p className="text-[17px] text-soft mt-1">Total a pagar: <b className="text-fg">{formatCOP(p.total)}</b></p>
        </div>

        <div className={`rounded-xl px-5 py-4 text-[16px] ${p.type === "completo" ? "bg-warn-soft border border-warn-line text-warn-ink" : "bg-brand-soft border border-brand-line text-brand-ink"}`}>
          {p.forceFull ? (
            <>Por el valor de esta compra la factura <b>requiere todos sus datos</b> (más de {formatCOP(p.threshold)} sin IVA).</>
          ) : (
            <>Sus datos son <b>opcionales</b>. Si no escribe su cédula, la factura se hace como <b>Consumidor final</b>.</>
          )}
          {!p.forceFull && (
            <label className="mt-3 flex items-center gap-3 cursor-pointer font-medium text-[16px]">
              <input type="checkbox" className="w-6 h-6" checked={p.manualFull} onChange={(e) => p.setManualFull(e.target.checked)} />
              Quiero la factura con todos mis datos (o a nombre de una empresa)
            </label>
          )}
        </div>

        {p.type === "corto" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
            <label className="col-span-1 sm:col-span-2">
              <span className={label}>Cédula (opcional)</span>
              <input className={input} inputMode="numeric" value={f.identification} onChange={(e) => set({ identification: e.target.value.replace(/\D/g, "") })} placeholder="Número de cédula" />
            </label>
            <label className="col-span-1 sm:col-span-2">
              <span className={label}>Nombre y apellido {f.identification ? "" : "(opcional)"}</span>
              <input className={input} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Nombre y apellido" />
            </label>
            <label>
              <span className={label}>Correo para recibir la factura (opcional)</span>
              <input className={input} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} placeholder="correo@ejemplo.com" />
            </label>
            <label>
              <span className={label}>Teléfono (opcional)</span>
              <input className={input} inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Teléfono" />
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
              <input
                className={input}
                inputMode="numeric"
                value={f.identification}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9A-Za-z]/g, "");
                  set({ identification: v, dv: isNit ? nitDv(v) : f.dv });
                }}
                placeholder="Número de documento"
              />
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
                <input className={input} value={f.company} onChange={(e) => set({ company: e.target.value })} placeholder="Razón social" />
              </label>
            ) : (
              <>
                <label className="col-span-2 sm:col-span-3">
                  <span className={label}>Nombres</span>
                  <input className={input} value={f.first} onChange={(e) => set({ first: e.target.value })} placeholder="Nombres" />
                </label>
                <label className="col-span-2 sm:col-span-3">
                  <span className={label}>Apellidos</span>
                  <input className={input} value={f.last} onChange={(e) => set({ last: e.target.value })} placeholder="Apellidos" />
                </label>
              </>
            )}
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Correo</span>
              <input className={input} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} placeholder="correo@ejemplo.com" />
            </label>
            <label className="col-span-2 sm:col-span-3">
              <span className={label}>Teléfono (opcional)</span>
              <input className={input} inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Teléfono" />
            </label>
            <label className="col-span-2 sm:col-span-6">
              <span className={label}>Dirección</span>
              <input className={input} value={f.address} onChange={(e) => set({ address: e.target.value })} placeholder="Dirección" />
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
          <button onClick={p.onNext} disabled={p.busy} className="flex-1 py-4 rounded-xl bg-go hover:bg-go-hover text-white text-2xl font-bold disabled:opacity-60">
            {p.busy ? "Preparando el pago…" : `Continuar al pago · ${formatCOP(p.total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
