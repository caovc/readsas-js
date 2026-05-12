import { readFile } from 'node:fs/promises';
import { readSas } from './index';
import type { ReadSasOptions, SasReadResult } from './types';

export async function readSasFile(path: string | URL, options: ReadSasOptions = {}): Promise<SasReadResult> {
  const bytes = await readFile(path);
  return readSas(bytes, options);
}

export * from './index';
