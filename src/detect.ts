import { sliceAscii } from './binary';
import type { FormatDetection, SasFileFormat } from './types';

const XPORT_V5_LIBRARY_HEADER = /HEADER RECORD\*+LIBRARY\s+HEADER RECORD/u;
const XPORT_V8_LIBRARY_HEADER = /HEADER RECORD\*+LIBV8\s+HEADER RECORD/u;
const SAS7BDAT_MAGIC = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xc2, 0xea, 0x81, 0x60,
  0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00,
  0x09, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11,
];

export function detectSasFormat(bytes: Uint8Array): FormatDetection {
  const head = sliceAscii(bytes, 0, Math.min(bytes.length, 512));
  const trimmed = head.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return { format: 'dataset-json', confidence: 0.7, reason: 'Input starts with JSON syntax.' };
  }

  if (XPORT_V8_LIBRARY_HEADER.test(head)) {
    return { format: 'xport-v8', confidence: 0.95, reason: 'SAS XPORT V8 library header found.' };
  }

  if (XPORT_V5_LIBRARY_HEADER.test(head)) {
    return { format: 'xport-v5', confidence: 0.95, reason: 'SAS XPORT V5 library header found.' };
  }

  if (looksLikeSas7bdat(bytes, head)) {
    return { format: 'sas7bdat', confidence: 0.85, reason: 'SAS7BDAT magic/header markers found.' };
  }

  return { format: 'dataset-json', confidence: 0.2, reason: 'No binary SAS markers found; trying Dataset-JSON.' };
}

export function assertKnownFormat(format: SasFileFormat | 'auto'): asserts format is SasFileFormat | 'auto' {
  if (!['auto', 'xport-v5', 'xport-v8', 'sas7bdat', 'dataset-json'].includes(format)) {
    throw new Error(`Unknown format option: ${format}`);
  }
}

function looksLikeSas7bdat(bytes: Uint8Array, _head: string): boolean {
  if (bytes.length < 32) {
    return false;
  }
  return SAS7BDAT_MAGIC.every((byte, index) => bytes[index] === byte);
}
