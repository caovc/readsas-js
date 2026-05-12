import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { detectSasFormat, readSas } from '../src';
import type { SasDataset, SasReadResult } from '../src';

function fail(message: string): never {
  throw new Error(message);
}

function firstDataset(result: SasReadResult): SasDataset {
  return result.datasets[0] ?? fail('Expected at least one dataset');
}

describe('readSas', () => {
  it('reads Dataset-JSON row arrays', async () => {
    const result = await readSas(
      JSON.stringify({
        datasetJSONVersion: '1.1.0',
        name: 'AE',
        label: 'Adverse Events',
        columns: [
          { name: 'USUBJID', dataType: 'string', label: 'Subject' },
          { name: 'AESEQ', dataType: 'integer' },
        ],
        rows: [
          ['01', 1],
          ['02', 2],
        ],
      }),
    );

    const dataset = firstDataset(result);
    expect(result.meta.datasetCount).toBe(1);
    expect(dataset.meta.format).toBe('dataset-json');
    expect(dataset.meta.name).toBe('AE');
    expect(dataset.meta.source).toMatchObject({
      datasetJSONVersion: '1.1.0',
    });
    expect(dataset.columns).toHaveLength(2);
    expect(dataset.records).toEqual([
      { USUBJID: '01', AESEQ: 1 },
      { USUBJID: '02', AESEQ: 2 },
    ]);
  });

  it('detects and reads an XPORT v5 file without relying on extension', async () => {
    const bytes = buildXportV5();

    expect(detectSasFormat(bytes).format).toBe('xport-v5');

    const result = await readSas(bytes);
    const dataset = firstDataset(result);
    expect(result.meta.datasetCount).toBe(1);
    expect(dataset.meta.format).toBe('xport-v5');
    expect(dataset.meta.fileType).toBe('DATA');
    expect(dataset.meta.sasRelease).toBe('9.4');
    expect(dataset.meta.host).toBe('WIN');
    expect(dataset.meta.createdAt).toBe('2026-05-12T12:00:00.000Z');
    expect(dataset.meta.source).toMatchObject({
      library: { libraryName: 'SASLIB' },
      member: { memberName: 'PEOPLE', memberType: 'DATA' },
    });
    expect(dataset.columns.map((column) => column.name)).toEqual(['NAME', 'AGE']);
    expect(dataset.records).toEqual([
      { NAME: 'Ada', AGE: 36 },
      { NAME: 'Linus', AGE: 55 },
    ]);
  });

  it('detects and reads an XPORT v8 file with long names and LABELV9 metadata', async () => {
    const bytes = buildXportV8();

    expect(detectSasFormat(bytes).format).toBe('xport-v8');

    const result = await readSas(bytes);
    const dataset = firstDataset(result);
    expect(result.meta.datasetCount).toBe(1);
    expect(dataset.meta.format).toBe('xport-v8');
    expect(dataset.meta.name).toBe('LONG_DATASET_NAME_FOR_V8');
    expect(dataset.meta.fileType).toBe('DATA');
    expect(dataset.meta.sasRelease).toBe('9.4');
    expect(dataset.meta.host).toBe('WIN');
    expect(dataset.columns).toMatchObject([
      {
        name: 'SUBJECT_IDENTIFIER',
        label: 'Subject identifier label longer than forty chars',
        type: 'string',
        length: 12,
      },
      {
        name: 'ANALYSIS_VISIT_NUMBER',
        label: 'Analysis visit number label',
        type: 'date',
        length: 8,
        format: 'DATE9.',
      },
    ]);
    expect(dataset.records).toEqual([
      { SUBJECT_IDENTIFIER: 'SUBJ-0001', ANALYSIS_VISIT_NUMBER: '1960-01-13' },
      { SUBJECT_IDENTIFIER: 'SUBJ-0002', ANALYSIS_VISIT_NUMBER: '1960-01-25' },
    ]);
  });

  it('decodes XPORT dataset labels with the requested encoding', async () => {
    const bytes = buildXportV8();
    writeLatin1(bytes, 6 * 80 + 32, 'Café dataset label', 40);

    const dataset = firstDataset(await readSas(bytes, { encoding: 'iso-8859-1' }));

    expect(dataset.meta.label).toBe('Café dataset label');
  });

  it('detects and reads an uncompressed SAS7BDAT file', async () => {
    const bytes = buildSas7bdat();

    expect(detectSasFormat(bytes).format).toBe('sas7bdat');
    const result = await readSas(bytes);
    const dataset = firstDataset(result);
    expect(result.meta.datasetCount).toBe(1);

    expect(dataset.meta.format).toBe('sas7bdat');
    expect(dataset.meta.name).toBe('PEOPLE');
    expect(dataset.meta.label).toBe('People table');
    expect(dataset.meta.fileType).toBe('DATA');
    expect(dataset.meta.fileFormat).toBe('windows');
    expect(dataset.meta.sasRelease).toBe('9.0401M6');
    expect(dataset.meta.host).toBe('Linux');
    expect(dataset.meta.endian).toBe('little');
    expect(dataset.meta.is64Bit).toBe(false);
    expect(dataset.meta.compression).toBe('none');
    expect(dataset.meta.source).toMatchObject({
      pageSize: 2048,
      pageCount: 2,
      rowLength: 40,
      totalRowCount: 2,
      encodingCode: 20,
    });
    expect(dataset.columns).toMatchObject([
      { name: 'NAME', label: 'Person name', type: 'string', length: 8 },
      { name: 'AGE', label: 'Age in years', type: 'number', length: 8, format: 'BEST12' },
      { name: 'BIRTHDT', label: 'Birth date', type: 'date', length: 8, format: 'DATE9' },
      { name: 'STARTDTM', label: 'Start datetime', type: 'datetime', length: 8, format: 'DATETIME20' },
      { name: 'DOSETM', label: 'Dose time', type: 'time', length: 8, format: 'TIME8' },
    ]);
    expect(dataset.records).toEqual([
      { NAME: 'Ada', AGE: 36, BIRTHDT: '1960-01-13', STARTDTM: '1960-01-01T01:00:00.000Z', DOSETM: '01:01:01' },
      { NAME: 'Linus', AGE: 55, BIRTHDT: '1960-01-25', STARTDTM: '1960-01-01T02:00:00.000Z', DOSETM: '02:02:02' },
    ]);
  });

  it('returns multiple Dataset-JSON datasets in a top-level datasets array', async () => {
    const result = await readSas(
      JSON.stringify({
        datasetJSONVersion: '1.1.0',
        datasets: [
          {
            name: 'DM',
            columns: [{ name: 'USUBJID', dataType: 'string' }],
            rows: [['01']],
          },
          {
            name: 'AE',
            columns: [{ name: 'AESEQ', dataType: 'integer' }],
            rows: [[1]],
          },
        ],
      }),
    );

    expect(result.meta).toMatchObject({ format: 'dataset-json', datasetCount: 2 });
    expect(result.datasets.map((dataset) => dataset.meta.name)).toEqual(['DM', 'AE']);
    expect(result.datasets[1]?.records).toEqual([{ AESEQ: 1 }]);
  });

  it('returns multiple XPORT members in a top-level datasets array', async () => {
    const result = await readSas(buildXportV5Multi());

    expect(result.meta).toMatchObject({ format: 'xport-v5', datasetCount: 2 });
    expect(result.datasets.map((dataset) => dataset.meta.name)).toEqual(['PEOPLE', 'SECOND']);
    expect(result.datasets[0]?.records).toEqual([
      { NAME: 'Ada', AGE: 36 },
      { NAME: 'Linus', AGE: 55 },
    ]);
    expect(result.datasets[1]?.records).toEqual([{ NAME: 'Grace', AGE: 72 }]);
  });

function buildXportV5(): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(record('HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000  '));
  parts.push(record('SAS     SAS     SASLIB  9.4     WIN                     12MAY26:12:00:00'));
  parts.push(record('12MAY26:12:00:00                                                            '));
  parts.push(...xportV5Member('PEOPLE', [row('Ada', 36), row('Linus', 55)]));
  return concat(parts);
}

function buildXportV5Multi(): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(record('HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000  '));
  parts.push(record('SAS     SAS     SASLIB  9.4     WIN                     12MAY26:12:00:00'));
  parts.push(record('12MAY26:12:00:00                                                            '));
  parts.push(...xportV5Member('PEOPLE', [row('Ada', 36), row('Linus', 55)], true));
  parts.push(...xportV5Member('SECOND', [row('Grace', 72)]));
  return concat(parts);
}

function xportV5Member(name: string, rows: Uint8Array[], padRows = false): Uint8Array[] {
  const parts: Uint8Array[] = [];
  parts.push(record('HEADER RECORD*******MEMBER  HEADER RECORD!!!!!!!000000000000000001600000000140'));
  parts.push(record('HEADER RECORD*******DSCRPTR HEADER RECORD!!!!!!!000000000000000000000000000000'));
  parts.push(record(`SAS     ${name.padEnd(8)}DATA    9.4     WIN                     12MAY26:12:00:00`));
  parts.push(record('12MAY26:12:00:00                                                            '));
  parts.push(record('HEADER RECORD*******NAMESTR HEADER RECORD!!!!!!!000000000200000000000000000000'));
  parts.push(...chunk(concat([namestr('NAME', 2, 8, 0), namestr('AGE', 1, 8, 8)]), 80));
  parts.push(record('HEADER RECORD*******OBS     HEADER RECORD!!!!!!!000000000000000000000000000000'));
  parts.push(...rows);
  if (padRows) parts.push(new Uint8Array(48).fill(0x20));
  return parts;
}

function buildXportV8(): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(record('HEADER RECORD*******LIBV8 HEADER RECORD!!!!!!!000000000000000000000000000000000'));
  parts.push(record('SAS     SAS     SASLIB  9.4     WIN                     12MAY26:12:00:00'));
  parts.push(record('12MAY26:12:00:00                                                            '));
  parts.push(record('HEADER RECORD*******MEMBV8 HEADER RECORD!!!!!!!000000000000000001600000000140'));
  parts.push(record('HEADER RECORD*******DSCPTV8 HEADER RECORD!!!!!!!000000000000000000000000000000'));
  parts.push(record('SAS     LONG_DATASET_NAME_FOR_V8        DATA    9.4     WIN     12MAY26:12:00:00'));
  parts.push(record('12MAY26:12:00:00            Long V8 member label                 '));
  parts.push(record('HEADER RECORD*******NAMSTV8 HEADER RECORD!!!!!!!000000000200000000000000000000'));
  parts.push(
    ...chunk(
      concat([
        namestrV8('SUBJECT_IDENTIFIER', 2, 12, 0, 'Subject identifier label'),
        namestrV8('ANALYSIS_VISIT_NUMBER', 1, 8, 12, 'Analysis visit number'),
      ]),
      80,
    ),
  );
  parts.push(record('HEADER RECORD*******LABELV9 HEADER RECORD!!!!!!!000000000200000000000000000000'));
  parts.push(
    ...chunk(
      concat([
        labelV9(1, 'SUBJECT_IDENTIFIER', 'Subject identifier label longer than forty chars', '', ''),
        labelV9(2, 'ANALYSIS_VISIT_NUMBER', 'Analysis visit number label', 'DATE9.', ''),
      ]),
      80,
    ),
  );
  parts.push(record('HEADER RECORD*******OBSV8 HEADER RECORD!!!!!!!000000000000000000000000000000000'));
  parts.push(rowV8('SUBJ-0001', 12));
  parts.push(rowV8('SUBJ-0002', 24));
  return concat(parts);
}

function buildSas7bdat(): Uint8Array {
  const headerSize = 1024;
  const pageSize = 2048;
  const pageCount = 2;
  const file = new Uint8Array(headerSize + pageSize * pageCount);
  const header = file.subarray(0, headerSize);
  header.set([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xc2, 0xea, 0x81, 0x60,
    0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00,
    0x09, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11,
  ]);
  header[32] = 0x22;
  header[35] = 0x22;
  header[37] = 0x01;
  header[39] = '2'.charCodeAt(0);
  header[70] = 20;
  writeText(header, 84, 'DATA    ', 8);
  writeText(header, 92, 'PEOPLE', 32);
  writeFloat64(header, 164, 0);
  writeFloat64(header, 172, 0);
  writeInt32LE(header, 196, headerSize);
  writeInt32LE(header, 200, pageSize);
  writeInt32LE(header, 204, pageCount);
  writeText(header, 216, '9.0401M6', 8);
  writeText(header, 224, 'Linux', 16);
  writeText(header, 240, 'SAS 9.4', 16);
  writeText(header, 256, 'x64', 16);
  writeText(header, 272, 'Linux', 16);

  const textEntries = makeSas7TextEntries([
    'NAME',
    'AGE',
    'BIRTHDT',
    'STARTDTM',
    'DOSETM',
    'BEST',
    'DATE9',
    'DATETIME20',
    'TIME8',
    'People table',
    'Person name',
    'Age in years',
    'Birth date',
    'Start datetime',
    'Dose time',
    'SASYZCRL',
  ]);
  const text = textEntries.text;
  const ref = (value: string): number => textEntries.refs[value] ?? fail(`Missing text ref: ${value}`);
  const textBytes = new TextEncoder().encode(text);
  const textSubheader = new Uint8Array(4 + 28 + textBytes.length);
  writeInt32LE(textSubheader, 0, 0xfffffffd);
  writeInt16LE(textSubheader, 4, textSubheader.length - 12);
  textSubheader.fill(0x20, 16, 24);
  textSubheader.set(textBytes, 32);
  const columnSize = subheader(0xf6f6f6f6, u32(5));
  const rowSize = new Uint8Array(480);
  writeInt32LE(rowSize, 0, 0xf7f7f7f7);
  writeInt32LE(rowSize, 20, 40);
  writeInt32LE(rowSize, 24, 2);
  writeInt32LE(rowSize, 60, 2);
  writeTextRef(rowSize, 0, ref('People table'), 'People table'.length, 350); // len - 130
  writeTextRef(rowSize, 0, ref('SASYZCRL'), 'SASYZCRL'.length, 362); // len - 118
  const colNames = new Uint8Array(60);
  writeInt32LE(colNames, 0, 0xffffffff);
  writeInt16LE(colNames, 4, colNames.length - 12);
  colNames.set(textRef(0, ref('NAME'), 'NAME'.length), 12);
  colNames.set(textRef(0, ref('AGE'), 'AGE'.length), 20);
  colNames.set(textRef(0, ref('BIRTHDT'), 'BIRTHDT'.length), 28);
  colNames.set(textRef(0, ref('STARTDTM'), 'STARTDTM'.length), 36);
  colNames.set(textRef(0, ref('DOSETM'), 'DOSETM'.length), 44);
  const colAttrs = new Uint8Array(80);
  writeInt32LE(colAttrs, 0, 0xfffffffc);
  writeInt16LE(colAttrs, 4, colAttrs.length - 12);
  colAttrs.set(columnAttr(0, 8, 0x02), 12);
  colAttrs.set(columnAttr(8, 8, 0x01), 24);
  colAttrs.set(columnAttr(16, 8, 0x01), 36);
  colAttrs.set(columnAttr(24, 8, 0x01), 48);
  colAttrs.set(columnAttr(32, 8, 0x01), 60);
  const format1 = columnFormat(0, 0, 0, 0, ref('Person name'), 'Person name'.length);
  const format2 = columnFormat(12, 0, ref('BEST'), 'BEST'.length, ref('Age in years'), 'Age in years'.length);
  const format3 = columnFormat(0, 0, ref('DATE9'), 'DATE9'.length, ref('Birth date'), 'Birth date'.length);
  const format4 = columnFormat(0, 0, ref('DATETIME20'), 'DATETIME20'.length, ref('Start datetime'), 'Start datetime'.length);
  const format5 = columnFormat(0, 0, ref('TIME8'), 'TIME8'.length, ref('Dose time'), 'Dose time'.length);
  writeMetaPage(file.subarray(headerSize, headerSize + pageSize), [textSubheader, columnSize, rowSize, colNames, colAttrs, format1, format2, format3, format4, format5]);

  const dataPage = file.subarray(headerSize + pageSize, headerSize + pageSize * 2);
  writeInt16LE(dataPage, 16, 0x0100);
  writeInt16LE(dataPage, 18, 2);
  dataPage.set(sas7Row('Ada', 36, 12, 3600, 3661), 24);
  dataPage.set(sas7Row('Linus', 55, 24, 7200, 7322), 64);
  return file;
}

function writeMetaPage(page: Uint8Array, subheaders: Uint8Array[]): void {
  const pointerSize = 12;
  writeInt16LE(page, 16, 0x0000);
  writeInt16LE(page, 20, subheaders.length);
  let dataOffset = page.length;
  subheaders.forEach((subheader, index) => {
    dataOffset -= subheader.length;
    page.set(subheader, dataOffset);
    const pointerOffset = 24 + index * pointerSize;
    writeInt32LE(page, pointerOffset, dataOffset);
    writeInt32LE(page, pointerOffset + 4, subheader.length);
    page[pointerOffset + 8] = 0x00;
    page[pointerOffset + 9] = 0x00;
  });
}

function makeSas7TextEntries(values: string[]): { text: string; refs: Record<string, number> } {
  let text = '';
  const refs: Record<string, number> = {};
  values.forEach((value) => {
    refs[value] = 28 + text.length;
    text += value;
  });
  return { text, refs };
}

function subheader(signature: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + body.length);
  writeInt32LE(bytes, 0, signature);
  bytes.set(body, 4);
  return bytes;
}

function columnAttr(offset: number, width: number, type: number): Uint8Array {
  const bytes = new Uint8Array(12);
  writeInt32LE(bytes, 0, offset);
  writeInt32LE(bytes, 4, width);
  bytes[10] = type;
  return bytes;
}

function columnFormat(width: number, digits: number, formatOffset: number, formatLength: number, labelOffset: number, labelLength: number): Uint8Array {
  const bytes = new Uint8Array(52);
  writeInt32LE(bytes, 0, 0xfffffbfe);
  writeInt16LE(bytes, 12, width);
  writeInt16LE(bytes, 14, digits);
  writeTextRef(bytes, 0, formatOffset, formatLength, 34);
  writeTextRef(bytes, 0, labelOffset, labelLength, 40);
  return bytes;
}

function sas7Row(name: string, age: number, date: number, datetime: number, time: number): Uint8Array {
  const bytes = new Uint8Array(40);
  writeText(bytes, 0, name, 8);
  writeFloat64(bytes, 8, age);
  writeFloat64(bytes, 16, date);
  writeFloat64(bytes, 24, datetime);
  writeFloat64(bytes, 32, time);
  return bytes;
}

function textRef(index: number, offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(8);
  writeTextRef(bytes, index, offset, length, 0);
  return bytes;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  writeInt16LE(bytes, 0, value);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  writeInt32LE(bytes, 0, value);
  return bytes;
}

function namestr(name: string, type: number, length: number, position: number): Uint8Array {
  const bytes = new Uint8Array(140);
  writeInt16(bytes, 0, type);
  writeInt16(bytes, 4, length);
  writeText(bytes, 8, name, 8);
  writeText(bytes, 16, `${name} label`, 40);
  writeInt32(bytes, 84, position);
  return bytes;
}

function namestrV8(name: string, type: number, length: number, position: number, label: string): Uint8Array {
  const bytes = new Uint8Array(140);
  writeInt16(bytes, 0, type);
  writeInt16(bytes, 4, length);
  writeText(bytes, 8, name, 8);
  writeText(bytes, 16, label, 40);
  writeInt32(bytes, 84, position);
  writeText(bytes, 88, name, 32);
  writeInt16(bytes, 120, label.length);
  return bytes;
}

function labelV9(variableNumber: number, name: string, label: string, format: string, informat: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const labelBytes = new TextEncoder().encode(label);
  const formatBytes = new TextEncoder().encode(format);
  const informatBytes = new TextEncoder().encode(informat);
  const bytes = new Uint8Array(5 + nameBytes.length + labelBytes.length + formatBytes.length + informatBytes.length);
  bytes[0] = variableNumber;
  bytes[1] = nameBytes.length;
  bytes[2] = labelBytes.length;
  bytes[3] = formatBytes.length;
  bytes[4] = informatBytes.length;
  let offset = 5;
  bytes.set(nameBytes, offset);
  offset += nameBytes.length;
  bytes.set(labelBytes, offset);
  offset += labelBytes.length;
  bytes.set(formatBytes, offset);
  offset += formatBytes.length;
  bytes.set(informatBytes, offset);
  return bytes;
}

function row(name: string, age: number): Uint8Array {
  const bytes = new Uint8Array(16);
  writeText(bytes, 0, name, 8);
  bytes.set(ibmNumber(age), 8);
  return bytes;
}

function rowV8(subject: string, visit: number): Uint8Array {
  const bytes = new Uint8Array(20);
  writeText(bytes, 0, subject, 12);
  bytes.set(ibmNumber(visit), 12);
  return bytes;
}

function record(value: string): Uint8Array {
  const bytes = new Uint8Array(80).fill(0x20);
  writeText(bytes, 0, value, 80);
  return bytes;
}

function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    const next = new Uint8Array(size).fill(0x20);
    next.set(bytes.subarray(offset, offset + size));
    chunks.push(next);
  }
  return chunks;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function writeText(bytes: Uint8Array, offset: number, value: string, length: number): void {
  const encoded = new TextEncoder().encode(value.padEnd(length).slice(0, length));
  bytes.set(encoded, offset);
}

function writeLatin1(bytes: Uint8Array, offset: number, value: string, length: number): void {
  const padded = value.padEnd(length).slice(0, length);
  for (let index = 0; index < padded.length; index += 1) {
    bytes[offset + index] = padded.charCodeAt(index) & 0xff;
  }
}

function writeInt16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeInt16LE(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
  view.setUint16(0, value, true);
}

function writeInt32LE(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  view.setUint32(0, value, true);
}

function writeFloat64(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  view.setFloat64(0, value, true);
}

function writeTextRef(bytes: Uint8Array, index: number, offset: number, length: number, targetOffset: number): void {
  writeInt16LE(bytes, targetOffset, index);
  writeInt16LE(bytes, targetOffset + 2, offset);
  writeInt16LE(bytes, targetOffset + 4, length);
}

function writeInt32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >> 24) & 0xff;
  bytes[offset + 1] = (value >> 16) & 0xff;
  bytes[offset + 2] = (value >> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function ibmNumber(value: number): Uint8Array {
  if (value === 0) return new Uint8Array(8);
  const sign = value < 0 ? 0x80 : 0;
  let fraction = Math.abs(value);
  let exponent = 64;
  while (fraction >= 1) {
    fraction /= 16;
    exponent += 1;
  }
  while (fraction < 1 / 16) {
    fraction *= 16;
    exponent -= 1;
  }
  let integer = Math.round(fraction * 0x100000000000000);
  const bytes = new Uint8Array(8);
  bytes[0] = sign | exponent;
  for (let index = 7; index >= 1; index -= 1) {
    bytes[index] = integer & 0xff;
    integer = Math.floor(integer / 256);
  }
  return bytes;
}
