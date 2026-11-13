import VentasClient from "@/components/sales/VentasClient";
import { requirePage } from "@/lib/auth";
import { todayBogota, yesterdayBogota } from "@/lib/sales";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Ventas" };

export default async function VentasPage() {
  const user = await requirePage("/ventas");
  return <VentasClient user={{ name: user.name, role: user.role }} today={todayBogota()} yesterday={yesterdayBogota()} />;
}
