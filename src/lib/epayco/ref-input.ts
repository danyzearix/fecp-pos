import type { RefKind } from "./attempts";

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Dónde encontrar la referencia que sirve para consultar (texto para el admin) */
export const WHERE_LONG_REF =
  "La referencia que sirve es la LARGA: 24 letras y números (p. ej. 6b048afc42f15b521510e422). Aparece en el enlace al que ePayco devuelve al cliente (…?ref_payco=…); " +
  "en el panel de Davipay búsquela en el detalle de la transacción. El número corto (p. ej. 395055851, «Referencia Davipay» o x_ref_payco) y el número de transacción " +
  "(x_transaction_id) NO sirven para consultar.";

/**
 * Qué escribió el admin. Reconoce: la referencia larga (ref_payco, 24 caracteres hexadecimales), un ENLACE que contenga ref_payco=, la
 * referencia corta (x_ref_payco: solo dígitos, hasta 12) y el x_transaction_id (solo dígitos, más largo).
 */
export function parseAdminRef(textRaw: string): { ref: string; kind: RefKind; source: "enlace" | "texto" } | null {
  const text = textRaw.trim();
  const m = /(?:^|[?&#\s])(ref_payco|x_ref_payco|x_transaction_id)=([A-Za-z0-9_-]{4,64})/.exec(text);
  const value = m ? m[2] : text;
  if (!ID_RE.test(value)) return null;
  let kind: RefKind;
  if (m?.[1] === "x_transaction_id") kind = "transaction_id";
  else if (m?.[1] === "x_ref_payco") kind = "corta";
  else if (/^\d+$/.test(value)) kind = value.length <= 12 ? "corta" : "transaction_id"; // la corta tiene ~9 dígitos; el x_transaction_id de PSE ~18
  else kind = "larga";
  return { ref: value, kind, source: m ? "enlace" : "texto" };
}
