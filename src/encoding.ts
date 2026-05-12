export function decodeBytes(bytes: Uint8Array, encoding = 'utf-8'): string {
  const label = normalizeEncoding(encoding);
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  }
  throw new Error('TextDecoder is not available in this runtime.');
}

export function encodeText(text: string, encoding = 'utf-8'): Uint8Array {
  const label = normalizeEncoding(encoding);
  if (label !== 'utf-8' && label !== 'utf8') {
    throw new Error(`TextEncoder only supports UTF-8 in this runtime; requested ${encoding}.`);
  }
  return new TextEncoder().encode(text);
}

export function normalizeEncoding(encoding: string): string {
  const lower = encoding.trim().toLowerCase();
  if (lower === 'utf8') return 'utf-8';
  if (lower === 'latin1') return 'iso-8859-1';
  return lower;
}
