import type { SasColumn, SasDataset, SasReadResult, SasValue } from '../types';
import { ParseError } from '../errors';
import { decodeBytes } from '../encoding';

type JsonRecord = Record<string, unknown>;

export function parseDatasetJson(bytes: Uint8Array, encoding = 'utf-8'): SasReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBytes(bytes, encoding));
  } catch (error) {
    throw new ParseError('Input is not valid JSON.', { cause: String(error) });
  }

  if (Array.isArray(parsed)) {
    const datasets = parsed.every(isDatasetLike)
      ? (parsed as JsonRecord[]).map((dataset) => fromDatasetObject(dataset, encoding))
      : [fromRecordArray(parsed as JsonRecord[], encoding)];
    return wrapDatasets('dataset-json', datasets, encoding);
  }
  if (!isObject(parsed)) {
    throw new ParseError('Dataset-JSON must be an object or an array of records.');
  }

  const root = parsed as JsonRecord;
  const datasetItems = root.datasets ?? root.itemGroups;
  if (Array.isArray(datasetItems)) {
    const datasets = datasetItems.map((dataset, index) => {
      if (!isObject(dataset)) {
        throw new ParseError('Dataset-JSON dataset entries must be objects.', { index });
      }
      return fromDatasetObject(dataset, encoding);
    });
    const { datasets: _datasets, itemGroups: _itemGroups, ...source } = root;
    return wrapDatasets('dataset-json', datasets, encoding, source);
  }

  return wrapDatasets('dataset-json', [fromDatasetObject(root, encoding)], encoding);
}

function fromDatasetObject(root: JsonRecord, encoding: string): SasDataset {
  const columns = parseColumns(root.columns);
  const records = parseRows(root.rows, root.records, columns);
  const { columns: _columns, rows: _rows, records: _records, ...source } = root;
  return {
    meta: {
      format: 'dataset-json',
      name: asString(root.name ?? root.datasetName ?? root.itemGroupOID),
      label: asString(root.label),
      encoding,
      rowCount: records.length,
      columnCount: columns.length,
      source,
    },
    columns,
    records,
  };
}

function wrapDatasets(format: 'dataset-json', datasets: SasDataset[], encoding: string, source?: Record<string, unknown>): SasReadResult {
  return {
    meta: {
      format,
      encoding,
      datasetCount: datasets.length,
      source,
    },
    datasets,
  };
}

function fromRecordArray(records: JsonRecord[], encoding: string): SasDataset {
  const names = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const columns = names.map<SasColumn>((name, position) => ({
    name,
    type: inferColumnType(records.map((record) => record[name])),
    position,
  }));
  return {
    meta: {
      format: 'dataset-json',
      encoding,
      rowCount: records.length,
      columnCount: columns.length,
    },
    columns,
    records: records.map((record) => normalizeRecord(record, columns)),
  };
}

function parseColumns(input: unknown): SasColumn[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((column, position) => {
    if (!isObject(column)) {
      throw new ParseError('Dataset-JSON column entries must be objects.', { position });
    }
    const raw = column as JsonRecord;
    const name = asString(raw.name ?? raw.itemOID ?? raw.ordinal);
    if (!name) {
      throw new ParseError('Dataset-JSON column is missing a name.', { position });
    }
    return {
      name,
      label: asString(raw.label),
      type: mapDatasetJsonType(asString(raw.dataType ?? raw.type)),
      length: asNumber(raw.length),
      format: asString(raw.displayFormat ?? raw.format),
      position,
    };
  });
}

function parseRows(rows: unknown, records: unknown, columns: SasColumn[]): Record<string, SasValue>[] {
  if (Array.isArray(records)) {
    if (records.every(isObject)) {
      const normalized = (records as JsonRecord[]).map((record) => normalizeRecord(record, columns));
      return normalized;
    }
    throw new ParseError('Dataset-JSON records must be objects.');
  }
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new ParseError('Dataset-JSON rows must be arrays.', { rowIndex });
    }
    const record: Record<string, SasValue> = {};
    columns.forEach((column, index) => {
      record[column.name] = normalizeValue(row[index]);
    });
    return record;
  });
}

function normalizeRecord(record: JsonRecord, columns: SasColumn[]): Record<string, SasValue> {
  const names = columns.length > 0 ? columns.map((column) => column.name) : Object.keys(record);
  const normalized: Record<string, SasValue> = {};
  names.forEach((name) => {
    normalized[name] = normalizeValue(record[name]);
  });
  return normalized;
}

function mapDatasetJsonType(type?: string): SasColumn['type'] {
  switch (type?.toLowerCase()) {
    case 'integer':
    case 'float':
    case 'double':
    case 'decimal':
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'time':
      return 'time';
    case 'boolean':
      return 'boolean';
    case 'string':
    case 'text':
      return 'string';
    default:
      return 'unknown';
  }
}

function inferColumnType(values: unknown[]): SasColumn['type'] {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'unknown';
  if (present.every((value) => typeof value === 'number')) return 'number';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'string')) return 'string';
  return 'unknown';
}

function normalizeValue(value: unknown): SasValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDatasetLike(value: unknown): value is JsonRecord {
  return isObject(value) && (Array.isArray(value.columns) || Array.isArray(value.rows) || Array.isArray(value.records));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
