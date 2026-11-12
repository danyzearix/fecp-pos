"use client";

import { useEffect, useRef, useState } from "react";

export type CartCustomer = {
  id: number | null; // null = consumidor final (no se ha creado en la BD de esta venta)
  id_type: string;
  identification: string;
  check_digit?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  state_code?: string | null;
  city_code?: string | null;
};

export const CONSUMIDOR_FINAL: CartCustomer = {
  id: null,
  id_type: "13",
  identification: "222222222222",
  first_name: "Consumidor",
  last_name: "final",
};

export const customerLabel = (c: CartCustomer) =>
  c.identification === CONSUMIDOR_FINAL.identification
    ? "Consumidor final"
    : c.company_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.identification;

type Props = { customer: CartCustomer | null; onChange: (c: CartCustomer | null) => void };

export default function CustomerPicker({ customer, onChange }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CartCustomer[]>([]);
  const [msg, setMsg] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setResults([]);
      setMsg("");
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(term)}`);
        if (!res.ok) throw new Error();
        const { customers } = (await res.json()) as { customers: CartCustomer[] };
        if (mine !== seq.current) return; // llegó una respuesta vieja
        setResults(customers);
        setMsg(customers.length ? "" : "Sin resultados. Se podrá registrar al cobrar.");
      } catch {
        if (mine === seq.current) setMsg("Sin conexión: se ingresará al cobrar.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  if (customer) {
    return (
      <div className="flex items-center justify-between bg-subtle border border-line rounded-lg px-3 py-2">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-body truncate">{customerLabel(customer)}</div>
          <div className="text-[12px] text-body">{customer.identification}</div>
        </div>
        <button
          onClick={() => onChange(null)}
          title="Quitar cliente"
          className="ml-2 w-11 h-11 shrink-0 rounded-full text-dim hover:bg-hover text-xl leading-none"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Cédula o NIT del cliente"
        inputMode="numeric"
        className="w-full border border-field rounded-lg px-3 py-2 text-[14px] text-soft placeholder:text-[14px] placeholder:text-faint outline-none focus:border-brand"
      />
      {(results.length > 0 || msg) && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg max-h-56 overflow-auto">
          {results.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                onChange(c);
                setQ("");
                setResults([]);
              }}
              className="block w-full text-left px-3 py-2 hover:bg-brand-soft"
            >
              <div className="text-[14px] font-medium text-body">{customerLabel(c)}</div>
              <div className="text-[12px] text-dim">{c.identification}</div>
            </button>
          ))}
          {msg && <div className="px-3 py-2 text-[13px] text-dim">{msg}</div>}
        </div>
      )}
      <button
        onClick={() => {
          onChange(CONSUMIDOR_FINAL);
          setQ("");
        }}
        className="mt-1 text-xs text-brand-text underline"
      >
        Usar Consumidor final
      </button>
    </div>
  );
}
