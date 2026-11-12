import VentasClient from "@/components/sales/VentasClient";
import { requirePage } from "@/lib/auth";
import { todayBogota, yesterdayBogota } from "@/lib/sales";

export default async function VentasPage() {
  const user = await requirePage("/ventas");
  return <VentasClient user={{ name: user.name, role: user.role }} today={todayBogota()} yesterday={yesterdayBogota()} />;
}
