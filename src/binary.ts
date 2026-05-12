import type { SasInput } from './types';
import { encodeText } from './encoding';

export async function toUint8Array(input: SasInput): Promise<Uint8Array> {
  if (typeof input === 'string') {
    return encodeText(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new TypeError('Unsupported input. Use ArrayBuffer, Uint8Array, Blob, or a JSON string.');
}

export function sliceAscii(bytes: Uint8Array, start: number, length: number): string {
  let value = '';
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

export function readInt16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

export function readInt16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
  return view.getUint16(0, littleEndian);
}

export function readInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

export function readInt32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, littleEndian);
}

export function readBigInt64(bytes: Uint8Array, offset: number, littleEndian: boolean): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, littleEndian);
}

export function readFloat64(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getFloat64(0, littleEndian);
}

export function trimNullsAndSpaces(value: string): string {
  return value.replace(/\0+$/u, '').trimEnd();
}

export function splitRecords(bytes: Uint8Array, recordLength = 80): Uint8Array[] {
  const records: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += recordLength) {
    records.push(bytes.subarray(offset, Math.min(offset + recordLength, bytes.length)));
  }
  return records;
}
