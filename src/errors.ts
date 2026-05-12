import type { SasFileFormat } from './types';

export class ReadSasError extends Error {
  constructor(message: string, readonly code: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ReadSasError';
  }
}

export class UnsupportedFormatError extends ReadSasError {
  constructor(format: SasFileFormat | string, details?: Record<string, unknown>) {
    super(`Unsupported SAS file format: ${format}`, 'UNSUPPORTED_FORMAT', details);
    this.name = 'UnsupportedFormatError';
  }
}

export class ParseError extends ReadSasError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PARSE_ERROR', details);
    this.name = 'ParseError';
  }
}

export class UnsupportedFeatureError extends ReadSasError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'UNSUPPORTED_FEATURE', details);
    this.name = 'UnsupportedFeatureError';
  }
}
