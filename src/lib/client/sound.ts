// Sonidos con Web Audio API (sin archivos).
let ctx: AudioContext | null = null;

function tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur);
  } catch {
    /* sin audio: no pasa nada */
  }
}

/** beep suave de éxito */
export const beepOk = () => tone(880, 0, 0.09, "sine", 0.15);

/** sonido corto de error (dos tonos graves) */
export const beepError = () => {
  tone(220, 0, 0.12, "square", 0.12);
  tone(165, 0.13, 0.18, "square", 0.12);
};
