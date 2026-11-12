import TicketPage from "@/components/ticket/TicketPage";
import { requirePage } from "@/lib/auth";

// Tirilla de 80 mm. Los datos los pide el navegador a /api/sales/[id], que también valida permisos.
export default async function Page({ params }: { params: Promise<{ saleId: string }> }) {
  await requirePage("/ticket");
  const { saleId } = await params;
  return (
    <>
      <style>{`
        @page { size: 80mm auto; margin: 0; }
        /* La tirilla SIEMPRE es blanco y negro, aunque el equipo esté en modo oscuro */
        html, body { background: #fff !important; color: #000 !important; color-scheme: light; margin: 0; }
        @media print { body { width: 80mm; } }
      `}</style>
      <TicketPage saleId={saleId} />
    </>
  );
}
