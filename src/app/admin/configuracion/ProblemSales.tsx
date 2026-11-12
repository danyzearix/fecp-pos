"use client";

import { useRouter } from "next/navigation";
import SaleActionButton from "@/components/sales/SaleActionButton";
import { statusInfo } from "@/components/sales/status";
import { formatCOP } from "@/lib/money";

export type Problem = {
  id: string;
  local_number: string;
  status: string;
  total: number;
  cashier: string;
  created_at: string;
  last_error: string | null;
};

export default function ProblemSales({ rows }: { rows: Problem[] }) {
  const router = useRouter();
  if (!rows.length) return <p className="text-[14px] text-ok-ink">✓ No hay ventas pendientes ni fallidas.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px] text-fg">
        <thead className="bg-subtle text-left text-[13px] text-body">
          <tr>
            <th className="px-3 py-2">Fecha</th>
            <th className="px-3 py-2">Venta</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2">Cajero</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Error</th>
            <th className="px-3 py-2">Acción</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="px-3 py-2 whitespace-nowrap text-[13px]">
                {new Date(r.created_at).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" })}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{r.local_number}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">{formatCOP(r.total)}</td>
              <td className="px-3 py-2">{r.cashier}</td>
              <td className="px-3 py-2">
                <span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${statusInfo(r.status).cls}`}>{statusInfo(r.status).label}</span>
              </td>
              <td className="px-3 py-2 text-[12px] text-soft max-w-md break-words">{r.last_error ?? "—"}</td>
              <td className="px-3 py-2">
                <SaleActionButton saleId={r.id} status={r.status} onDone={() => router.refresh()} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
