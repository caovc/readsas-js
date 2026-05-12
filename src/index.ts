import { toUint8Array } from './binary';
import { assertKnownFormat, detectSasFormat } from './detect';
import { parseDatasetJson } from './parsers/datasetJson';
import { parseSas7bdat } from './parsers/sas7bdat';
import { parseXport } from './parsers/xport';
import type { FormatDetection, ReadSasOptions, SasDataset, SasFileFormat, SasInput, SasReadResult } from './types';

export type {
  FormatDetection,
  ReadSasOptions,
  SasColumn,
  SasDataset,
  SasDatasetMeta,
  SasFileFormat,
  SasInput,
  SasReadResult,
  SasReadResultMeta,
  SasValue,
} from './types';
export { ParseError, ReadSasError, UnsupportedFeatureError, UnsupportedFormatError } from './errors';
export { detectSasFormat } from './detect';

export async function readSas(input: SasInput, options: ReadSasOptions = {}): Promise<SasReadResult> {
  const bytes = await toUint8Array(input);
  const format = options.format ?? 'auto';
  assertKnownFormat(format);
  const detected = format === 'auto' ? detectSasFormat(bytes) : ({ format, confidence: 1, reason: 'Forced by options.format.' } satisfies FormatDetection);
  return parseByFormat(bytes, detected.format, options.encoding);
}

export async function readSasDataset(input: SasInput, options: ReadSasOptions = {}): Promise<SasDataset> {
  const result = await readSas(input, options);
  const dataset = result.datasets[0];
  if (!dataset) {
    throw new Error('No datasets were found in the SAS input.');
  }
  return dataset;
}

export async function readSasMetadata(input: SasInput, options: ReadSasOptions = {}): Promise<SasReadResult['meta']> {
  const result = await readSas(input, options);
  return result.meta;
}

function parseByFormat(bytes: Uint8Array, format: SasFileFormat, encoding = 'utf-8'): SasReadResult {
  switch (format) {
    case 'dataset-json':
      return parseDatasetJson(bytes, encoding);
    case 'xport-v5':
    case 'xport-v8':
      return parseXport(bytes, format, encoding);
    case 'sas7bdat':
      return parseSas7bdat(bytes, encoding);
  }
}
