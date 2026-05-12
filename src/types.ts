export type SasFileFormat = 'xport-v5' | 'xport-v8' | 'sas7bdat' | 'dataset-json';

export type SasValue = string | number | boolean | null;

export interface ReadSasOptions {
  encoding?: string;
  format?: SasFileFormat | 'auto';
}

export interface SasColumn {
  name: string;
  label?: string;
  type: 'string' | 'number' | 'date' | 'datetime' | 'time' | 'boolean' | 'unknown';
  length?: number;
  format?: string;
  informat?: string;
  position?: number;
  source?: Record<string, unknown>;
}

export interface SasDatasetMeta {
  format: SasFileFormat;
  name?: string;
  label?: string;
  createdAt?: string;
  modifiedAt?: string;
  encoding?: string;
  fileType?: string;
  fileFormat?: string;
  sasRelease?: string;
  sasVersion?: string;
  host?: string;
  osName?: string;
  osVendor?: string;
  endian?: 'little' | 'big';
  is64Bit?: boolean;
  compression?: 'none' | 'rle' | 'rdc' | 'unknown';
  rowCount?: number;
  columnCount: number;
  source?: Record<string, unknown>;
}

export interface SasDataset {
  meta: SasDatasetMeta;
  columns: SasColumn[];
  records: Record<string, SasValue>[];
}

export interface SasReadResultMeta {
  format: SasFileFormat;
  encoding?: string;
  datasetCount: number;
  source?: Record<string, unknown>;
}

export interface SasReadResult {
  meta: SasReadResultMeta;
  datasets: SasDataset[];
}

export type SasInput = ArrayBuffer | ArrayBufferView | Blob | string;

export interface FormatDetection {
  format: SasFileFormat;
  confidence: number;
  reason: string;
}
