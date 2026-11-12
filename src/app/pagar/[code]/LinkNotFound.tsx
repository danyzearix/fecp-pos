export default function LinkNotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-app">
      <div className="max-w-[420px] bg-surface rounded-2xl border border-line p-6 text-center text-fg space-y-2">
        <div className="text-4xl">✕</div>
        <h1 className="text-xl font-bold">Enlace no válido</h1>
        <p className="text-[14px] text-soft">Este enlace de pago no existe o ya no está disponible. Pida uno nuevo en la tienda.</p>
      </div>
    </main>
  );
}
