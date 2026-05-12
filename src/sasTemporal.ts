import type { SasColumn, SasValue } from './types';

const SAS_EPOCH_OFFSET_SECONDS = 3653 * 86400;

export function inferSasNumericType(format?: string): SasColumn['type'] {
  const token = normalizeFormat(format);
  if (!token) return 'number';
  if (token.startsWith('DATETIME') || token.startsWith('E8601DT') || token.startsWith('B8601DT')) return 'datetime';
  if (token.startsWith('DATE') || token.startsWith('YYMMDD') || token.startsWith('MMDDYY') || token.startsWith('DDMMYY') || token.startsWith('E8601DA')) return 'date';
  if (token.startsWith('TIME') || token.startsWith('TOD') || token.startsWith('E8601TM')) return 'time';
  return 'number';
}

export function formatSasTemporalValue(value: number | null, column: Pick<SasColumn, 'type'>): SasValue {
  if (value === null) return null;
  switch (column.type) {
    case 'date':
      return formatSasDate(value);
    case 'datetime':
      return formatSasDateTime(value);
    case 'time':
      return formatSasTime(value);
    default:
      return value;
  }
}

export function formatSasDate(days: number): string {
  const date = new Date((days - SAS_EPOCH_OFFSET_SECONDS / 86400) * 86400 * 1000);
  return date.toISOString().slice(0, 10);
}

export function formatSasDateTime(seconds: number): string {
  return new Date((seconds - SAS_EPOCH_OFFSET_SECONDS) * 1000).toISOString();
}

export function formatSasTime(seconds: number): string {
  const normalized = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const wholeSeconds = Math.floor(normalized % 60);
  const millis = Math.round((normalized - Math.floor(normalized)) * 1000);
  const base = `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}`;
  return millis > 0 ? `${base}.${String(millis).padStart(3, '0')}` : base;
}

function normalizeFormat(format?: string): string {
  return (format ?? '').trim().replace(/\d+(?:\.\d+)?\.?$/u, '').replace(/\.$/u, '').toUpperCase();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
