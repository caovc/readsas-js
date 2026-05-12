import { decodeBytes } from '../encoding';
import { ParseError } from '../errors';
import { formatSasTemporalValue, inferSasNumericType } from '../sasTemporal';
import { readInt16BE, readInt32BE, sliceAscii, splitRecords, trimNullsAndSpaces } from '../binary';
import type { SasColumn, SasDataset, SasFileFormat, SasReadResult, SasValue } from '../types';

interface XportNameStr {
  column: SasColumn;
  rawType: number;
}

interface XportHeaderMeta {
  sasSymbol?: string;
  sasName?: string;
  libraryName?: string;
  memberName?: string;
  memberType?: string;
  sasRelease?: string;
  host?: string;
  createdAt?: string;
  modifiedAt?: string;
  rawCreatedAt?: string;
  rawModifiedAt?: string;
}

export function parseXport(bytes: Uint8Array, format: Extract<SasFileFormat, 'xport-v5' | 'xport-v8'>, encoding = 'utf-8'): SasReadResult {
  const records = splitRecords(bytes);
  const headers = records.map((record) => sliceAscii(record, 0, record.length));
  const libraryMeta = readLibraryMeta(records, encoding);
  const descriptorMarker = headerRecordPattern(format === 'xport-v8' ? 'DSCPTV8' : 'DSCRPTR');
  const datasets: SasDataset[] = [];
  let searchStart = 0;
  while (searchStart < headers.length) {
    const descriptorHeaderIndex = headers.findIndex((header, index) => index >= searchStart && descriptorMarker.test(header));
    if (descriptorHeaderIndex < 0) break;
    const parsed = parseXportDataset(bytes, records, headers, format, encoding, descriptorHeaderIndex, libraryMeta);
    datasets.push(parsed.dataset);
    searchStart = parsed.nextRecordIndex;
  }
  if (datasets.length === 0) {
    throw new ParseError('SAS XPORT dataset descriptor header was not found.');
  }
  return {
    meta: {
      format,
      encoding,
      datasetCount: datasets.length,
      source: {
        library: libraryMeta,
      },
    },
    datasets,
  };
}

function parseXportDataset(
  bytes: Uint8Array,
  records: Uint8Array[],
  headers: string[],
  format: Extract<SasFileFormat, 'xport-v5' | 'xport-v8'>,
  encoding: string,
  descriptorHeaderIndex: number,
  libraryMeta: XportHeaderMeta,
): { dataset: SasDataset; nextRecordIndex: number } {
  const nameStrMarker = headerRecordPattern(format === 'xport-v8' ? 'NAMSTV8' : 'NAMESTR');
  const obsMarker = headerRecordPattern(format === 'xport-v8' ? 'OBSV8' : 'OBS');
  const memberMarker = headerRecordPattern(format === 'xport-v8' ? 'MEMBV8' : 'MEMBER');
  const nameStrHeaderIndex = headers.findIndex((header, index) => index > descriptorHeaderIndex && nameStrMarker.test(header));
  if (nameStrHeaderIndex < 0) {
    throw new ParseError('SAS XPORT NAMESTR header was not found.');
  }

  const variableCount = readHeaderCount(headers[nameStrHeaderIndex] ?? '');
  const nameStrSize = chooseNameStrSize(format, variableCount, records, nameStrHeaderIndex);
  const nameStrStart = (nameStrHeaderIndex + 1) * 80;
  const nameStrBytes = bytes.subarray(nameStrStart, nameStrStart + variableCount * nameStrSize);
  const variables = parseNameStrs(nameStrBytes, variableCount, nameStrSize, format, encoding);

  const obsHeaderIndex = headers.findIndex(
    (header, index) => index > nameStrHeaderIndex && obsMarker.test(header),
  );
  if (obsHeaderIndex < 0) {
    throw new ParseError('SAS XPORT OBS header was not found.');
  }
  if (format === 'xport-v8') {
    applyV8LabelDescriptors(bytes, headers, variables, nameStrHeaderIndex, obsHeaderIndex, encoding);
  }

  const rowLength = variables.reduce((sum, variable) => sum + (variable.column.length ?? 0), 0);
  if (rowLength <= 0) {
    throw new ParseError('SAS XPORT row length is zero.');
  }

  const dataStart = (obsHeaderIndex + 1) * 80;
  const nextMemberIndex = headers.findIndex((header, index) => index > obsHeaderIndex && memberMarker.test(header));
  const dataEnd = nextMemberIndex >= 0 ? nextMemberIndex * 80 : bytes.length;
  const dataLength = dataEnd - dataStart;
  const rowCount = Math.floor(dataLength / rowLength);
  const outputRecords: Record<string, SasValue>[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowOffset = dataStart + rowIndex * rowLength;
    const record: Record<string, SasValue> = {};
    let offset = rowOffset;
    for (const variable of variables) {
      const length = variable.column.length ?? 0;
      const valueBytes = bytes.subarray(offset, offset + length);
      record[variable.column.name] =
        variable.rawType === 1 ? formatSasTemporalValue(parseIbmNumber(valueBytes), variable.column) : parseCharacter(valueBytes, encoding);
      offset += length;
    }
    if (!isPaddingRecord(record)) {
      outputRecords.push(record);
    }
  }

  const memberMeta = readMemberMeta(records, descriptorHeaderIndex, format, encoding);
  return {
    dataset: {
      meta: {
        format,
        name: memberMeta.memberName,
        label: readMemberLabel(records, descriptorHeaderIndex, encoding),
        createdAt: memberMeta.createdAt,
        modifiedAt: memberMeta.modifiedAt,
        encoding,
        fileType: memberMeta.memberType,
        sasRelease: memberMeta.sasRelease ?? libraryMeta.sasRelease,
        host: memberMeta.host ?? libraryMeta.host,
        endian: 'big',
        rowCount: outputRecords.length,
        columnCount: variables.length,
        source: {
          library: libraryMeta,
          member: memberMeta,
          nameStrSize,
          descriptorHeaderIndex,
          nameStrHeaderIndex,
          obsHeaderIndex,
          dataStart,
          dataEnd,
        },
      },
      columns: variables.map((variable) => variable.column),
      records: outputRecords,
    },
    nextRecordIndex: nextMemberIndex >= 0 ? nextMemberIndex : headers.length,
  };
}

function readHeaderCount(header: string): number {
  const bangIndex = header.indexOf('!!!!!!!');
  const tail = bangIndex >= 0 ? header.slice(bangIndex + 7) : header;
  const fixedWidthValues = tail.match(/.{1,10}/gu) ?? [];
  const count = fixedWidthValues.map((value) => Number(value)).find((value) => Number.isInteger(value) && value > 0);
  if (!count) {
    throw new ParseError('Could not determine SAS XPORT variable count.', { header });
  }
  return count;
}

function headerRecordPattern(name: string): RegExp {
  return new RegExp(`HEADER RECORD\\*+${name}\\s+HEADER RECORD`, 'u');
}

function chooseNameStrSize(
  format: Extract<SasFileFormat, 'xport-v5' | 'xport-v8'>,
  variableCount: number,
  records: Uint8Array[],
  headerIndex: number,
): number {
  if (format === 'xport-v8') {
    return 140;
  }
  const remaining = (records.length - headerIndex - 1) * 80;
  return remaining >= variableCount * 140 ? 140 : 136;
}

function parseNameStrs(
  bytes: Uint8Array,
  count: number,
  size: number,
  format: Extract<SasFileFormat, 'xport-v5' | 'xport-v8'>,
  encoding: string,
): XportNameStr[] {
  const variables: XportNameStr[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * size;
    const rawType = readInt16BE(bytes, offset);
    const length = readInt16BE(bytes, offset + 4);
    const shortName = trimNullsAndSpaces(decodeBytes(bytes.subarray(offset + 8, offset + 16), encoding));
    const longName =
      format === 'xport-v8' ? trimNullsAndSpaces(decodeBytes(bytes.subarray(offset + 88, offset + 120), encoding)) : '';
    const name = longName || shortName;
    if (!name) {
      throw new ParseError('SAS XPORT variable name is empty.', { index });
    }
    const label = trimNullsAndSpaces(decodeBytes(bytes.subarray(offset + 16, offset + 56), encoding));
    const columnFormat = trimNullsAndSpaces(decodeBytes(bytes.subarray(offset + 56, offset + 64), encoding)) || undefined;
    variables.push({
      rawType,
      column: {
        name,
        label: label || undefined,
        type: rawType === 1 ? inferSasNumericType(columnFormat) : rawType === 2 ? 'string' : 'unknown',
        length,
        format: columnFormat,
        informat: trimNullsAndSpaces(decodeBytes(bytes.subarray(offset + 72, offset + 80), encoding)) || undefined,
        position: readInt32BE(bytes, offset + 84),
      },
    });
  }
  return variables;
}

function applyV8LabelDescriptors(
  bytes: Uint8Array,
  headers: string[],
  variables: XportNameStr[],
  nameStrHeaderIndex: number,
  obsHeaderIndex: number,
  encoding: string,
): void {
  const labelHeaderIndex = headers.findIndex(
    (header, index) =>
      index > nameStrHeaderIndex &&
      index < obsHeaderIndex &&
      (headerRecordPattern('LABELV8').test(header) ||
        headerRecordPattern('LABELV9').test(header)),
  );
  if (labelHeaderIndex < 0) {
    return;
  }

  const labelKind = headerRecordPattern('LABELV9').test(headers[labelHeaderIndex] ?? '') ? 'LABELV9' : 'LABELV8';
  const descriptorCount = readHeaderCount(headers[labelHeaderIndex] ?? '');
  const stream = bytes.subarray((labelHeaderIndex + 1) * 80, obsHeaderIndex * 80);
  let offset = 0;

  for (let descriptorIndex = 0; descriptorIndex < descriptorCount; descriptorIndex += 1) {
    if (labelKind === 'LABELV8') {
      if (offset + 6 > stream.length) {
        throw new ParseError('Truncated LABELV8 descriptor.', { descriptorIndex });
      }
      const variableNumber = readInt16BE(stream, offset);
      const nameLength = readInt16BE(stream, offset + 2);
      const labelLength = readInt16BE(stream, offset + 4);
      offset += 6;
      const name = trimNullsAndSpaces(decodeBytes(stream.subarray(offset, offset + nameLength), encoding));
      offset += nameLength;
      const label = trimNullsAndSpaces(decodeBytes(stream.subarray(offset, offset + labelLength), encoding));
      offset += labelLength;
      applyDescriptorValues(variables, variableNumber, name, label);
    } else {
      if (offset + 5 > stream.length) {
        throw new ParseError('Truncated LABELV9 descriptor.', { descriptorIndex });
      }
      const variableNumber = stream[offset] ?? 0;
      const nameLength = stream[offset + 1] ?? 0;
      const labelLength = stream[offset + 2] ?? 0;
      const formatLength = stream[offset + 3] ?? 0;
      const informatLength = stream[offset + 4] ?? 0;
      offset += 5;
      const name = trimNullsAndSpaces(decodeBytes(stream.subarray(offset, offset + nameLength), encoding));
      offset += nameLength;
      const label = trimNullsAndSpaces(decodeBytes(stream.subarray(offset, offset + labelLength), encoding));
      offset += labelLength;
      const formatText = trimNullsAndSpaces(decodeBytes(stream.subarray(offset, offset + formatLength), encoding));
      offset += formatLength;
      const informatText = trimNullsAndSpaces(decodeBytes(stream.subarray(offset, offset + informatLength), encoding));
      offset += informatLength;
      applyDescriptorValues(variables, variableNumber, name, label, formatText, informatText);
    }
  }
}

function applyDescriptorValues(
  variables: XportNameStr[],
  variableNumber: number,
  name?: string,
  label?: string,
  format?: string,
  informat?: string,
): void {
  const variable = variables[variableNumber - 1];
  if (!variable) {
    throw new ParseError('LABEL descriptor references an unknown variable.', { variableNumber });
  }
  if (name) variable.column.name = name;
  if (label) variable.column.label = label;
  if (format) {
    variable.column.format = format;
    if (variable.rawType === 1) variable.column.type = inferSasNumericType(format);
  }
  if (informat) variable.column.informat = informat;
}

function parseCharacter(bytes: Uint8Array, encoding: string): string | null {
  const value = trimNullsAndSpaces(decodeBytes(bytes, encoding)).trimEnd();
  return value.length > 0 ? value : null;
}

export function parseIbmNumber(bytes: Uint8Array): number | null {
  if (bytes.every((byte) => byte === 0x20)) {
    return null;
  }
  if (bytes.every((byte) => byte === 0x00)) {
    return 0;
  }
  if (bytes.length === 8 && bytes[0] === 0x2e && bytes.subarray(1).every((byte) => byte === 0x00)) {
    return null;
  }
  const first = bytes[0] ?? 0;
  const sign = (first & 0x80) === 0 ? 1 : -1;
  const exponent = (first & 0x7f) - 64;
  let fraction = 0;
  for (let index = 1; index < Math.min(bytes.length, 8); index += 1) {
    fraction = fraction * 256 + (bytes[index] ?? 0);
  }
  fraction /= 0x100000000000000;
  const value = sign * fraction * 16 ** exponent;
  return Number.isFinite(value) ? value : null;
}

function isPaddingRecord(record: Record<string, SasValue>): boolean {
  return Object.values(record).every((value) => value === null || value === '');
}

function readMemberName(records: Uint8Array[], descriptorHeaderIndex: number, format: Extract<SasFileFormat, 'xport-v5' | 'xport-v8'>, encoding: string): string | undefined {
  const member = descriptorHeaderIndex >= 0 ? records[descriptorHeaderIndex + 1] : undefined;
  if (!member) return undefined;
  const length = format === 'xport-v8' ? 32 : 8;
  return trimNullsAndSpaces(decodeBytes(member.subarray(8, 8 + length), encoding)) || undefined;
}

function readMemberLabel(records: Uint8Array[], descriptorHeaderIndex: number, encoding: string): string | undefined {
  const secondHeader = descriptorHeaderIndex >= 0 ? records[descriptorHeaderIndex + 2] : undefined;
  if (!secondHeader) return undefined;
  return trimNullsAndSpaces(decodeBytes(secondHeader.subarray(32, 72), encoding)) || undefined;
}

function readLibraryMeta(records: Uint8Array[], encoding: string): XportHeaderMeta {
  const first = records[1];
  const second = records[2];
  if (!first) return {};
  const rawCreatedAt = readEncodedField(first, 56, 16, encoding);
  const rawModifiedAt = second ? readEncodedField(second, 0, 16, encoding) : undefined;
  return {
    sasSymbol: readEncodedField(first, 0, 8, encoding),
    sasName: readEncodedField(first, 8, 8, encoding),
    libraryName: readEncodedField(first, 16, 8, encoding),
    sasRelease: readEncodedField(first, 24, 8, encoding),
    host: readEncodedField(first, 32, 8, encoding),
    createdAt: parseXportDate(rawCreatedAt),
    modifiedAt: parseXportDate(rawModifiedAt),
    rawCreatedAt,
    rawModifiedAt,
  };
}

function readMemberMeta(
  records: Uint8Array[],
  descriptorHeaderIndex: number,
  format: Extract<SasFileFormat, 'xport-v5' | 'xport-v8'>,
  encoding: string,
): XportHeaderMeta {
  const first = descriptorHeaderIndex >= 0 ? records[descriptorHeaderIndex + 1] : undefined;
  const second = descriptorHeaderIndex >= 0 ? records[descriptorHeaderIndex + 2] : undefined;
  if (!first) return {};
  const rawCreatedAt = readEncodedField(first, format === 'xport-v8' ? 64 : 56, 16, encoding);
  const rawModifiedAt = second ? readEncodedField(second, 0, 16, encoding) : undefined;
  return {
    sasSymbol: readEncodedField(first, 0, 8, encoding),
    memberName: readMemberName(records, descriptorHeaderIndex, format, encoding),
    memberType: readEncodedField(first, format === 'xport-v8' ? 40 : 16, 8, encoding),
    sasRelease: readEncodedField(first, format === 'xport-v8' ? 48 : 24, 8, encoding),
    host: readEncodedField(first, format === 'xport-v8' ? 56 : 32, 8, encoding),
    createdAt: parseXportDate(rawCreatedAt),
    modifiedAt: parseXportDate(rawModifiedAt),
    rawCreatedAt,
    rawModifiedAt,
  };
}

function readEncodedField(record: Uint8Array, offset: number, length: number, encoding: string): string | undefined {
  return trimNullsAndSpaces(decodeBytes(record.subarray(offset, offset + length), encoding)) || undefined;
}

function parseXportDate(value?: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{1,2})([A-Z]{3})(\d{2}):(\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) return undefined;
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[match[2] ?? ''];
  if (month === undefined) return undefined;
  const yy = Number(match[3]);
  const year = yy < 40 ? 2000 + yy : 1900 + yy;
  const date = new Date(Date.UTC(year, month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
