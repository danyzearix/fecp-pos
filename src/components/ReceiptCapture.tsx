"use client";

// Foto del comprobante con la cámara web (getUserMedia): vista previa en vivo → Capturar → Repetir / Usar esta foto.
// Si no hay cámara o el permiso se niega, ofrece "Subir imagen desde el equipo" (solo imágenes) y explica cómo habilitar
// la cámara en Chrome. La imagen se reduce aquí (máx. 1600 px, JPEG) antes de entregarla.
import { useCallback, useEffect, useRef, useState } from "react";
import { shrinkImage } from "@/lib/client/receipts";
import { RECEIPT_MAX_BYTES, RECEIPT_MAX_SIDE } from "@/lib/receipt-rules";

type CamError = "denied" | "nocam" | "busy" | "insecure" | "other";

const CAM_MSG: Record<CamError, string> = {
  denied: "Chrome bloqueó la cámara para este sitio.",
  nocam: "No se encontró ninguna cámara en este equipo.",
  busy: "La cámara está siendo usada por otro programa (cierre la otra aplicación e intente de nuevo).",
  insecure: "La cámara solo funciona si la página se abre con https:// (o en 127.0.0.1 en el propio equipo).",
  other: "No se pudo encender la cámara.",
};

export default function ReceiptCapture({ title, onAccept, onCancel }: { title?: string; onAccept: (b: Blob) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [camError, setCamError] = useState<CamError | null>(null);
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  const start = useCallback(async () => {
    setMsg("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCamError(window.isSecureContext ? "nocam" : "insecure");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setCamError(null);
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
        // "Capturar" aparece solo cuando la cámara ya entrega imagen (antes, videoWidth es 0 y no habría foto)
        if (!v.videoWidth) await new Promise<void>((res) => v.addEventListener("loadeddata", () => res(), { once: true }));
      }
      setReady(true);
    } catch (e) {
      const n = e instanceof DOMException ? e.name : "";
      setCamError(n === "NotAllowedError" || n === "SecurityError" ? "denied" : n === "NotFoundError" || n === "OverconstrainedError" ? "nocam" : n === "NotReadableError" ? "busy" : "other");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- encender la cámara al abrir (sistema externo)
    void start();
    return () => stop();
  }, [start, stop]);

  // Esc cierra (y no deja que el modal de cobro de abajo lo reciba)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "F9") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  // Al volver de "Repetir" el <video> se vuelve a montar: se le conecta otra vez la cámara
  useEffect(() => {
    const v = videoRef.current;
    if (!shot && ready && v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => {});
    }
  }, [shot, ready]);

  // Libera la vista previa al cambiarla o al cerrar
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const scale = Math.min(1, RECEIPT_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(
      (b) => {
        if (!b) return setMsg("No se pudo tomar la foto. Intente de nuevo.");
        setShot({ blob: b, url: URL.createObjectURL(b) });
        stop(); // la cámara se apaga mientras se revisa la foto
      },
      "image/jpeg",
      0.85
    );
  }

  async function fromFile(f: File | undefined) {
    if (!f) return;
    setMsg("");
    if (!f.type.startsWith("image/")) return setMsg("Solo se aceptan imágenes (JPG, PNG o WebP).");
    if (f.size > RECEIPT_MAX_BYTES) return setMsg("La imagen pesa más de 10 MB.");
    setBusy(true);
    try {
      const b = await shrinkImage(f);
      stop();
      setShot({ blob: b, url: URL.createObjectURL(b) });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo leer la imagen.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function retake() {
    setShot(null);
    void start();
  }

  function accept() {
    if (!shot) return;
    stop();
    onAccept(shot.blob);
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Foto del comprobante">
      <div className="bg-surface text-fg w-full h-full sm:h-auto sm:max-h-[95vh] sm:max-w-[720px] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 sm:px-6 py-3 border-b border-line flex items-center justify-between gap-3 shrink-0">
          <h2 className="text-lg font-bold">{title ?? "Foto del comprobante"}</h2>
          <button onClick={onCancel} className="px-3 min-h-11 rounded-lg border border-field text-[14px] text-body">Cerrar</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
          {/* Vista previa en vivo o foto tomada */}
          <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3] max-h-[60vh] mx-auto w-full grid place-items-center">
            {shot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shot.url} alt="Foto del comprobante" className="w-full h-full object-contain" />
            ) : (
              <video ref={videoRef} playsInline muted autoPlay className={`w-full h-full object-contain ${ready ? "" : "opacity-0"}`} />
            )}
            {!shot && !ready && !camError && <div className="absolute text-white text-[14px]">Encendiendo la cámara…</div>}
            {!shot && camError && (
              <div className="absolute inset-0 grid place-items-center p-4 text-center text-white text-[14px]">{CAM_MSG[camError]}</div>
            )}
          </div>

          {camError === "denied" && !shot && (
            <div className="rounded-lg border border-warn-line bg-warn-soft text-warn-ink px-3 py-2 text-[13px] space-y-1">
              <div className="font-semibold">Para habilitar la cámara en Chrome:</div>
              <ol className="list-decimal pl-5 space-y-0.5">
                <li>Toque el ícono a la izquierda de la dirección (el candado o los controles del sitio).</li>
                <li>En <b>Cámara</b>, elija <b>Permitir</b>.</li>
                <li>Recargue la página e intente de nuevo. (También en Configuración → Privacidad y seguridad → Configuración de sitios → Cámara.)</li>
              </ol>
            </div>
          )}

          {msg && <p className="text-[13px] text-err-ink">{msg}</p>}

          <div className="flex flex-wrap gap-3 justify-center">
            {shot ? (
              <>
                <button onClick={retake} className="px-5 min-h-12 rounded-lg border border-field text-[15px] font-medium text-body">Repetir</button>
                <button onClick={accept} className="px-6 min-h-12 rounded-lg bg-go hover:bg-go-hover text-white text-[15px] font-bold">Usar esta foto</button>
              </>
            ) : (
              <>
                {ready && (
                  <button onClick={capture} className="px-6 min-h-12 rounded-lg bg-brand text-white text-[15px] font-bold">Capturar</button>
                )}
                {camError && camError !== "insecure" && (
                  <button onClick={() => void start()} className="px-5 min-h-12 rounded-lg border border-field text-[14px] font-medium text-body">Reintentar cámara</button>
                )}
                <button onClick={() => fileRef.current?.click()} disabled={busy} className="px-5 min-h-12 rounded-lg border border-brand text-brand-text text-[14px] font-semibold hover:bg-brand-soft disabled:opacity-50">
                  {busy ? "Procesando…" : "Subir imagen desde el equipo"}
                </button>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void fromFile(e.target.files?.[0])} />
        </div>
      </div>
    </div>
  );
}
