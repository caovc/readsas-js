import { readBigInt64, readFloat64, readInt16, readInt32, sliceAscii, trimNullsAndSpaces } from '../binary';
import { decodeBytes } from '../encoding';
import { ParseError, UnsupportedFeatureError } from '../errors';
import { formatSasTemporalValue, inferSasNumericType } from '../sasTemporal';
import type { SasColumn, SasDataset, SasReadResult, SasValue } from '../types';

const MAGIC = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xc2, 0xea, 0x81, 0x60,
  0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00,
  0x09, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11,
];

const ALIGNMENT_OFFSET_4 = 0x33;
const ENDIAN_BIG = 0x00;
const ENDIAN_LITTLE = 0x01;
const COLUMN_TYPE_NUM = 0x01;
const COLUMN_TYPE_CHR = 0x02;

const PAGE_TYPE_DATA = 0x0100;
const PAGE_TYPE_MIX = 0x0200;
const PAGE_TYPE_MASK = 0x0f00;
const PAGE_TYPE_COMP = 0x9000;

const COMPRESSION_NONE = 0x00;
const COMPRESSION_TRUNC = 0x01;
const COMPRESSION_ROW = 0x04;
const COMPRESSION_SIGNATURE_RDC = 'SASYZCR2';

type SubheaderType =
  | 'data'
  | 'row-size'
  | 'column-size'
  | 'counts'
  | 'column-format'
  | 'column-attrs'
  | 'column-text'
  | 'column-list'
  | 'column-name'
  | 'unknown';

interface Sas7Header {
  littleEndian: boolean;
  u64: boolean;
  vendor: 'sas' | 'stat-transfer';
  headerSize: number;
  pageSize: number;
  pageCount: number;
  pageHeaderSize: number;
  subheaderPointerSize: number;
  subheaderSignatureSize: number;
  tableName?: string;
  encoding: string;
  encodingCode: number;
  fileFormat?: string;
  fileType?: string;
  fileInfo?: string;
  release?: string;
  host?: string;
  sasVersion?: string;
  osVendor?: string;
  osName?: string;
  createdAt?: string;
  modifiedAt?: string;
  version?: number;
}

interface TextRef {
  index: number;
  offset: number;
  length: number;
}

interface ColumnInfo {
  nameRef?: TextRef;
  formatRef?: TextRef;
  labelRef?: TextRef;
  index: number;
  offset: number;
  width: number;
  rawType: number;
  formatWidth: number;
  formatDigits: number;
  column?: SasColumn;
}

interface SubheaderPointer {
  offset: number;
  length: number;
  compression: number;
  isCompressedData: number;
}

interface Sas7Context {
  bytes: Uint8Array;
  header: Sas7Header;
  textBlobs: Uint8Array[];
  columnInfo: ColumnInfo[];
  columnCount: number;
  rowLength: number;
  pageRowCount: number;
  totalRowCount: number;
  fileLabel?: string;
  rdcCompression: boolean;
  maxColumnWidth: number;
  columnsSubmitted: boolean;
  columns: SasColumn[];
  records: Record<string, SasValue>[];
  encoding: string;
}

export function parseSas7bdat(bytes: Uint8Array, encoding?: string): SasReadResult {
  const header = parseHeader(bytes, encoding);
  const ctx: Sas7Context = {
    bytes,
    header,
    textBlobs: [],
    columnInfo: [],
    columnCount: 0,
    rowLength: 0,
    pageRowCount: 0,
    totalRowCount: 0,
    rdcCompression: false,
    maxColumnWidth: 0,
    columnsSubmitted: false,
    columns: [],
    records: [],
    encoding: encoding ?? header.encoding,
  };

  const lastExamined = parseMetaPagesPass1(ctx);
  parseAmdPagesPass1(ctx, lastExamined);
  parseAllPagesPass2(ctx);
  submitColumnsIfNeeded(ctx, false);

  const dataset: SasDataset = {
    meta: {
      format: 'sas7bdat',
      name: header.tableName,
      label: ctx.fileLabel,
      createdAt: header.createdAt,
      modifiedAt: header.modifiedAt,
      encoding: ctx.encoding,
      fileType: header.fileType,
      fileFormat: header.fileFormat,
      sasRelease: header.release,
      sasVersion: header.sasVersion,
      host: header.host,
      osName: header.osName,
      osVendor: header.osVendor,
      endian: header.littleEndian ? 'little' : 'big',
      is64Bit: header.u64,
      compression: ctx.rdcCompression ? 'rdc' : 'none',
      rowCount: ctx.records.length,
      columnCount: ctx.columns.length,
      source: {
        fileInfo: header.fileInfo,
        encodingCode: header.encodingCode,
        pageSize: header.pageSize,
        pageCount: header.pageCount,
        headerSize: header.headerSize,
        pageHeaderSize: header.pageHeaderSize,
        subheaderPointerSize: header.subheaderPointerSize,
        subheaderSignatureSize: header.subheaderSignatureSize,
        is64Bit: header.u64,
        endianness: header.littleEndian ? 'little' : 'big',
        sasVersion: header.version,
        vendor: header.vendor,
        rowLength: ctx.rowLength,
        pageRowCount: ctx.pageRowCount,
        totalRowCount: ctx.totalRowCount,
        maxColumnWidth: ctx.maxColumnWidth,
        compression: ctx.rdcCompression ? 'rdc' : undefined,
      },
    },
    columns: ctx.columns,
    records: ctx.records,
  };
  return {
    meta: {
      format: 'sas7bdat',
      encoding: ctx.encoding,
      datasetCount: 1,
      source: dataset.meta.source,
    },
    datasets: [dataset],
  };
}

function parseHeader(bytes: Uint8Array, requestedEncoding?: string): Sas7Header {
  if (bytes.length < 1024) {
    throw new ParseError('SAS7BDAT file is too small to contain a valid header.');
  }
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new ParseError('SAS7BDAT magic number does not match.');
  }

  const pad1 = bytes[35] === ALIGNMENT_OFFSET_4 ? 4 : 0;
  const u64 = bytes[32] === ALIGNMENT_OFFSET_4;
  const endian = bytes[37];
  if (endian !== ENDIAN_BIG && endian !== ENDIAN_LITTLE) {
    throw new ParseError('SAS7BDAT endian marker is invalid.', { endian });
  }
  const littleEndian = endian === ENDIAN_LITTLE;
  const encodingCode = bytes[70] ?? 0;
  const encoding = requestedEncoding ?? mapSasEncoding(encodingCode);
  const fileFormat = decodeFileFormat(bytes[39]);
  const fileType = trimNullsAndSpaces(decodeBytes(bytes.subarray(84, 92), encoding)) || undefined;
  const tableName = trimNullsAndSpaces(decodeBytes(bytes.subarray(92, 124), encoding)) || undefined;
  const fileInfo = trimNullsAndSpaces(decodeBytes(bytes.subarray(156, 164), encoding)) || undefined;

  let offset = 164 + pad1;
  const createdAt = sasDateTimeToIso(readFloat64(bytes, offset, littleEndian));
  offset += 8;
  const modifiedAt = sasDateTimeToIso(readFloat64(bytes, offset, littleEndian));
  offset += 8;
  offset += 16;
  const headerSize = readInt32(bytes, offset, littleEndian);
  offset += 4;
  const pageSize = readInt32(bytes, offset, littleEndian);
  offset += 4;
  const pageCount = Number(u64 ? readBigInt64(bytes, offset, littleEndian) : BigInt(readInt32(bytes, offset, littleEndian)));
  offset += u64 ? 8 : 4;

  if (headerSize < 1024 || pageSize < 1024 || headerSize > 1 << 24 || pageSize > 1 << 24) {
    throw new ParseError('SAS7BDAT header or page size is invalid.', { headerSize, pageSize });
  }
  if (pageCount > 1 << 24) {
    throw new ParseError('SAS7BDAT page count is invalid.', { pageCount });
  }

  offset += 8;
  const release = trimNullsAndSpaces(sliceAscii(bytes, offset, 8)) || undefined;
  const host = trimNullsAndSpaces(sliceAscii(bytes, offset + 8, 16)) || undefined;
  const sasVersion = trimNullsAndSpaces(sliceAscii(bytes, offset + 24, 16)) || undefined;
  const osVendor = trimNullsAndSpaces(sliceAscii(bytes, offset + 40, 16)) || undefined;
  const osName = trimNullsAndSpaces(sliceAscii(bytes, offset + 56, 16)) || undefined;
  const version = parseMajorVersion(release);
  const minorRevision = parseMinorRevision(release);
  const vendor = version && (version === 8 || version === 9) && minorRevision?.minor === 0 && minorRevision.revision === 0 ? 'stat-transfer' : 'sas';

  return {
    littleEndian,
    u64,
    vendor,
    headerSize,
    pageSize,
    pageCount,
    pageHeaderSize: u64 ? 40 : 24,
    subheaderPointerSize: u64 ? 24 : 12,
    subheaderSignatureSize: u64 ? 8 : 4,
    tableName,
    encoding,
    encodingCode,
    fileFormat,
    fileType,
    fileInfo,
    release,
    host,
    sasVersion,
    osVendor,
    osName,
    createdAt,
    modifiedAt,
    version,
  };
}

function parseMetaPagesPass1(ctx: Sas7Context): number {
  let pageIndex = 0;
  for (; pageIndex < ctx.header.pageCount; pageIndex += 1) {
    const page = getPage(ctx, pageIndex);
    const pageType = readPageType(ctx, page);
    if ((pageType & PAGE_TYPE_MASK) === PAGE_TYPE_DATA) break;
    if (pageType & PAGE_TYPE_COMP) continue;
    parsePagePass1(ctx, page);
  }
  return pageIndex;
}

function parseAmdPagesPass1(ctx: Sas7Context, lastExamined: number): void {
  let amdPageCount = 0;
  for (let pageIndex = ctx.header.pageCount - 1; pageIndex > lastExamined; pageIndex -= 1) {
    const page = getPage(ctx, pageIndex);
    const pageType = readPageType(ctx, page);
    if ((pageType & PAGE_TYPE_MASK) === PAGE_TYPE_DATA) {
      if (amdPageCount > 0) break;
      continue;
    }
    if (pageType & PAGE_TYPE_COMP) continue;
    parsePagePass1(ctx, page);
    amdPageCount += 1;
  }
}

function parseAllPagesPass2(ctx: Sas7Context): void {
  for (let pageIndex = 0; pageIndex < ctx.header.pageCount; pageIndex += 1) {
    parsePagePass2(ctx, getPage(ctx, pageIndex));
    if (ctx.totalRowCount > 0 && ctx.records.length >= ctx.totalRowCount) break;
  }
}

function parsePagePass1(ctx: Sas7Context, page: Uint8Array): void {
  for (const pointer of readSubheaderPointers(ctx, page)) {
    if (pointer.length > 0 && pointer.compression !== COMPRESSION_TRUNC) {
      validateSubheaderPointer(ctx, pointer, page);
      if (pointer.compression === COMPRESSION_NONE) {
        const subheader = page.subarray(pointer.offset, pointer.offset + pointer.length);
        if (parseSubheaderType(ctx, subheader) === 'column-text') parseSubheader(ctx, 'column-text', subheader);
      } else if (pointer.compression !== COMPRESSION_ROW) {
        throw new UnsupportedFeatureError('Unsupported SAS7BDAT subheader compression.', { compression: pointer.compression });
      }
    }
  }
}

function parsePagePass2(ctx: Sas7Context, page: Uint8Array): void {
  const pageType = readPageType(ctx, page);
  let data: Uint8Array | undefined;
  if ((pageType & PAGE_TYPE_MASK) === PAGE_TYPE_DATA) {
    ctx.pageRowCount = readInt16(page, ctx.header.pageHeaderSize - 6, ctx.header.littleEndian);
    data = page.subarray(ctx.header.pageHeaderSize);
  } else if (!(pageType & PAGE_TYPE_COMP)) {
    const pointers = readSubheaderPointers(ctx, page);
    for (const pointer of pointers) {
      if (pointer.length === 0 || pointer.compression === COMPRESSION_TRUNC) continue;
      validateSubheaderPointer(ctx, pointer, page);
      const subheader = page.subarray(pointer.offset, pointer.offset + pointer.length);
      if (pointer.compression === COMPRESSION_NONE) {
        const type = parseSubheaderType(ctx, subheader);
        if (type === 'data' && pointer.isCompressedData) {
          if (pointer.length !== ctx.rowLength) throw new ParseError('SAS7BDAT compressed row width mismatch.');
          submitColumnsIfNeeded(ctx, true);
          parseSingleRow(ctx, subheader);
        } else if (type !== 'column-text') {
          parseSubheader(ctx, type, subheader);
        }
      } else if (pointer.compression === COMPRESSION_ROW) {
        submitColumnsIfNeeded(ctx, true);
        parseCompressedSubheader(ctx, subheader);
      } else {
        throw new UnsupportedFeatureError('Unsupported SAS7BDAT subheader compression.', { compression: pointer.compression });
      }
    }
    if ((pageType & PAGE_TYPE_MASK) === PAGE_TYPE_MIX) {
      const offset = mixedPageDataOffset(ctx, page, pointers);
      data = page.subarray(offset);
    }
  }
  if (data) {
    submitColumnsIfNeeded(ctx, false);
    parseRows(ctx, data);
  }
}

function parseSubheader(ctx: Sas7Context, type: SubheaderType, subheader: Uint8Array): void {
  if (subheader.length < 2 + ctx.header.subheaderSignatureSize) throw new ParseError('SAS7BDAT subheader is truncated.');
  switch (type) {
    case 'row-size':
      parseRowSizeSubheader(ctx, subheader);
      break;
    case 'column-size':
      parseColumnSizeSubheader(ctx, subheader);
      break;
    case 'column-text':
      parseColumnTextSubheader(ctx, subheader);
      break;
    case 'column-name':
      parseColumnNameSubheader(ctx, subheader);
      break;
    case 'column-attrs':
      parseColumnAttributesSubheader(ctx, subheader);
      break;
    case 'column-format':
      parseColumnFormatSubheader(ctx, subheader);
      break;
    case 'counts':
    case 'column-list':
    case 'unknown':
      break;
    case 'data':
      break;
  }
}

function parseColumnTextSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  const signatureLength = ctx.header.subheaderSignatureSize;
  validateRemainder(ctx, subheader);
  ctx.textBlobs.push(subheader.slice(signatureLength));
}

function parseColumnSizeSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  const minimum = ctx.header.u64 ? 16 : 8;
  if (subheader.length < minimum) throw new ParseError('SAS7BDAT column-size subheader is truncated.');
  const count = Number(ctx.header.u64 ? readBigInt64(subheader, 8, ctx.header.littleEndian) : BigInt(readInt32(subheader, 4, ctx.header.littleEndian)));
  ctx.columnCount = count;
  ensureColumnInfo(ctx, count);
}

function parseRowSizeSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  const minimum = ctx.header.u64 ? 250 : 190;
  if (subheader.length < minimum) throw new ParseError('SAS7BDAT row-size subheader is truncated.');
  if (ctx.header.u64) {
    ctx.rowLength = Number(readBigInt64(subheader, 40, ctx.header.littleEndian));
    ctx.totalRowCount = Number(readBigInt64(subheader, 48, ctx.header.littleEndian));
    ctx.pageRowCount = Number(readBigInt64(subheader, 120, ctx.header.littleEndian));
  } else {
    ctx.rowLength = readInt32(subheader, 20, ctx.header.littleEndian);
    ctx.totalRowCount = readInt32(subheader, 24, ctx.header.littleEndian);
    ctx.pageRowCount = readInt32(subheader, 60, ctx.header.littleEndian);
  }
  const labelRef = parseTextRef(ctx, subheader, subheader.length - 130);
  if (labelRef.length) ctx.fileLabel = copyTextRef(ctx, labelRef);
  const compressionRef = parseTextRef(ctx, subheader, subheader.length - 118);
  if (compressionRef.length) ctx.rdcCompression = copyTextRef(ctx, compressionRef).startsWith(COMPRESSION_SIGNATURE_RDC);
}

function parseColumnNameSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  validateRemainder(ctx, subheader);
  const count = Math.floor((subheader.length - (ctx.header.u64 ? 28 : 20)) / 8);
  const start = ctx.columnInfo.filter((column) => column.nameRef).length;
  let offset = ctx.header.subheaderSignatureSize + 8;
  ensureColumnInfo(ctx, start + count);
  for (let index = start; index < start + count; index += 1) {
    ctx.columnInfo[index]!.nameRef = parseTextRef(ctx, subheader, offset);
    offset += 8;
  }
}

function parseColumnAttributesSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  validateRemainder(ctx, subheader);
  const entrySize = ctx.header.u64 ? 16 : 12;
  const count = Math.floor((subheader.length - (ctx.header.u64 ? 28 : 20)) / entrySize);
  const start = ctx.columnInfo.filter((column) => column.width > 0 || column.rawType > 0).length;
  let offset = ctx.header.subheaderSignatureSize + 8;
  ensureColumnInfo(ctx, start + count);
  for (let index = start; index < start + count; index += 1) {
    const info = ctx.columnInfo[index]!;
    info.offset = Number(ctx.header.u64 ? readBigInt64(subheader, offset, ctx.header.littleEndian) : BigInt(readInt32(subheader, offset, ctx.header.littleEndian)));
    const widthOffset = offset + (ctx.header.u64 ? 8 : 4);
    info.width = readInt32(subheader, widthOffset, ctx.header.littleEndian);
    info.rawType = subheader[widthOffset + 6] ?? 0;
    info.index = index;
    ctx.maxColumnWidth = Math.max(ctx.maxColumnWidth, info.width);
    offset += entrySize;
  }
}

function parseColumnFormatSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  const minimum = ctx.header.u64 ? 58 : 46;
  if (subheader.length < minimum) throw new ParseError('SAS7BDAT column-format subheader is truncated.');
  const index = ctx.columnInfo.filter((column) => column.formatRef || column.labelRef).length;
  ensureColumnInfo(ctx, index + 1);
  const info = ctx.columnInfo[index]!;
  if (ctx.header.u64) {
    info.formatWidth = readInt16(subheader, 24, ctx.header.littleEndian);
    info.formatDigits = readInt16(subheader, 26, ctx.header.littleEndian);
    info.formatRef = parseTextRef(ctx, subheader, 46);
    info.labelRef = parseTextRef(ctx, subheader, 52);
  } else {
    info.formatWidth = readInt16(subheader, 12, ctx.header.littleEndian);
    info.formatDigits = readInt16(subheader, 14, ctx.header.littleEndian);
    info.formatRef = parseTextRef(ctx, subheader, 34);
    info.labelRef = parseTextRef(ctx, subheader, 40);
  }
}

function submitColumnsIfNeeded(ctx: Sas7Context, compressed: boolean): void {
  if (ctx.columnsSubmitted) return;
  ensureColumnInfo(ctx, ctx.columnCount);
  ctx.columns = ctx.columnInfo.slice(0, ctx.columnCount).map((info, index) => {
    validateColumn(info);
    const name = info.nameRef ? copyTextRef(ctx, info.nameRef) : `VAR${index + 1}`;
    const baseFormat = info.formatRef ? copyTextRef(ctx, info.formatRef) : '';
    let format = baseFormat;
    if (info.formatWidth) format += String(info.formatWidth);
    if (format && info.formatDigits) format += `.${info.formatDigits}`;
    const label = info.labelRef ? copyTextRef(ctx, info.labelRef) : undefined;
    const column: SasColumn = {
      name,
      label: label || undefined,
      type: info.rawType === COLUMN_TYPE_NUM ? inferSasNumericType(format) : info.rawType === COLUMN_TYPE_CHR ? 'string' : 'unknown',
      length: info.width,
      format: format || undefined,
      position: index,
      source: {
        offset: info.offset,
        rawType: info.rawType,
      },
    };
    info.column = column;
    return column;
  });
  ctx.columnsSubmitted = true;
  if (compressed) {
    ctx.header;
  }
}

function parseRows(ctx: Sas7Context, data: Uint8Array): void {
  if (!ctx.rowLength) return;
  let offset = 0;
  for (let index = 0; index < ctx.pageRowCount && ctx.records.length < ctx.totalRowCount; index += 1) {
    if (offset + ctx.rowLength > data.length) throw new ParseError('SAS7BDAT row width mismatch.');
    parseSingleRow(ctx, data.subarray(offset, offset + ctx.rowLength));
    offset += ctx.rowLength;
  }
}

function parseSingleRow(ctx: Sas7Context, row: Uint8Array): void {
  const record: Record<string, SasValue> = {};
  for (const info of ctx.columnInfo.slice(0, ctx.columnCount)) {
    const column = info.column;
    if (!column) continue;
    if (info.offset > ctx.rowLength || info.offset + info.width > ctx.rowLength) {
      throw new ParseError('SAS7BDAT column offset exceeds row length.', { column: column.name });
    }
    const colData = row.subarray(info.offset, info.offset + info.width);
    record[column.name] = info.rawType === COLUMN_TYPE_NUM ? formatSasTemporalValue(parseSasNumber(ctx, colData), column) : parseSasString(ctx, colData);
  }
  ctx.records.push(record);
}

function parseCompressedSubheader(ctx: Sas7Context, subheader: Uint8Array): void {
  const row = ctx.rdcCompression ? decompressRdc(subheader, ctx.rowLength) : decompressRle(subheader, ctx.rowLength);
  parseSingleRow(ctx, row);
}

function parseSasNumber(ctx: Sas7Context, bytes: Uint8Array): number | null {
  if (bytes.length < 3 || bytes.length > 8) throw new ParseError('SAS7BDAT numeric width must be between 3 and 8 bytes.');
  const full = new Uint8Array(8);
  if (ctx.header.littleEndian) {
    full.set(bytes);
  } else {
    full.set(bytes, 8 - bytes.length);
  }
  const value = readFloat64(full, 0, ctx.header.littleEndian);
  return Number.isNaN(value) ? null : value;
}

function parseSasString(ctx: Sas7Context, bytes: Uint8Array): string | null {
  const value = trimNullsAndSpaces(decodeBytes(bytes, ctx.encoding)).trimEnd();
  return value ? value : null;
}

function readSubheaderPointers(ctx: Sas7Context, page: Uint8Array): SubheaderPointer[] {
  const count = readInt16(page, ctx.header.pageHeaderSize - 4, ctx.header.littleEndian);
  if (ctx.header.pageHeaderSize + count * ctx.header.subheaderPointerSize > ctx.header.pageSize) {
    throw new ParseError('SAS7BDAT subheader pointer table exceeds page size.');
  }
  const pointers: SubheaderPointer[] = [];
  let offset = ctx.header.pageHeaderSize;
  for (let index = 0; index < count; index += 1) {
    if (ctx.header.u64) {
      pointers.push({
        offset: Number(readBigInt64(page, offset, ctx.header.littleEndian)),
        length: Number(readBigInt64(page, offset + 8, ctx.header.littleEndian)),
        compression: page[offset + 16] ?? 0,
        isCompressedData: page[offset + 17] ?? 0,
      });
    } else {
      pointers.push({
        offset: readInt32(page, offset, ctx.header.littleEndian),
        length: readInt32(page, offset + 4, ctx.header.littleEndian),
        compression: page[offset + 8] ?? 0,
        isCompressedData: page[offset + 9] ?? 0,
      });
    }
    offset += ctx.header.subheaderPointerSize;
  }
  return pointers;
}

function validateSubheaderPointer(ctx: Sas7Context, pointer: SubheaderPointer, page: Uint8Array): void {
  const pointerTableEnd = ctx.header.pageHeaderSize + readSubheaderPointerCount(ctx, page) * ctx.header.subheaderPointerSize;
  if (pointer.offset > ctx.header.pageSize || pointer.length > ctx.header.pageSize || pointer.offset + pointer.length > ctx.header.pageSize) {
    throw new ParseError('SAS7BDAT subheader pointer is outside the page.', { ...pointer });
  }
  if (pointer.offset < pointerTableEnd) {
    throw new ParseError('SAS7BDAT subheader overlaps pointer table.', { ...pointer });
  }
  if (pointer.compression === COMPRESSION_NONE && pointer.length < ctx.header.subheaderSignatureSize) {
    throw new ParseError('SAS7BDAT subheader is shorter than its signature.', { ...pointer });
  }
}

function parseSubheaderType(ctx: Sas7Context, subheader: Uint8Array): SubheaderType {
  if (!ctx.header.u64) return parseSubheaderType32(readInt32(subheader, 0, ctx.header.littleEndian));
  const signature = readBigInt64(subheader, 0, ctx.header.littleEndian);
  if (signature === 0xf7f7f7f7n) return 'row-size';
  if (signature === 0xf6f6f6f6n) return 'column-size';
  if ((signature & 0xffffffff00000000n) !== 0xffffffff00000000n) return 'data';
  return parseSubheaderType32(Number(signature & 0xffffffffn));
}

function parseSubheaderType32(signature: number): SubheaderType {
  switch (signature >>> 0) {
    case 0xf7f7f7f7:
      return 'row-size';
    case 0xf6f6f6f6:
      return 'column-size';
    case 0xfffffc00:
      return 'counts';
    case 0xfffffbfe:
      return 'column-format';
    case 0xfffffffc:
      return 'column-attrs';
    case 0xfffffffd:
      return 'column-text';
    case 0xfffffffe:
      return 'column-list';
    case 0xffffffff:
      return 'column-name';
    default:
      return (signature & 0xfffffff8) === 0xfffffff8 ? 'unknown' : 'data';
  }
}

function parseTextRef(ctx: Sas7Context, bytes: Uint8Array, offset: number): TextRef {
  return {
    index: readInt16(bytes, offset, ctx.header.littleEndian),
    offset: readInt16(bytes, offset + 2, ctx.header.littleEndian),
    length: readInt16(bytes, offset + 4, ctx.header.littleEndian),
  };
}

function copyTextRef(ctx: Sas7Context, ref: TextRef): string {
  const blob = ctx.textBlobs[ref.index];
  if (!blob) throw new ParseError('SAS7BDAT text reference points to a missing text blob.', { ...ref });
  if (ref.offset + ref.length > blob.length) throw new ParseError('SAS7BDAT text reference exceeds text blob length.', { ...ref });
  return trimNullsAndSpaces(decodeBytes(blob.subarray(ref.offset, ref.offset + ref.length), ctx.encoding));
}

function validateRemainder(ctx: Sas7Context, subheader: Uint8Array): void {
  const signatureLength = ctx.header.subheaderSignatureSize;
  const remainder = readInt16(subheader, signatureLength, ctx.header.littleEndian);
  const expected = subheader.length - (4 + 2 * signatureLength);
  if (remainder !== expected) {
    throw new ParseError('SAS7BDAT subheader remainder mismatch.', { remainder, expected });
  }
}

function ensureColumnInfo(ctx: Sas7Context, count: number): void {
  while (ctx.columnInfo.length < count) {
    ctx.columnInfo.push({ index: ctx.columnInfo.length, offset: 0, width: 0, rawType: 0, formatWidth: 0, formatDigits: 0 });
  }
}

function validateColumn(info: ColumnInfo): void {
  if (info.rawType === COLUMN_TYPE_NUM && (info.width < 3 || info.width > 8)) {
    throw new ParseError('SAS7BDAT numeric column has invalid width.', { width: info.width });
  }
  if (info.rawType !== COLUMN_TYPE_NUM && info.rawType !== COLUMN_TYPE_CHR) {
    throw new ParseError('SAS7BDAT column has unknown type.', { type: info.rawType });
  }
}

function getPage(ctx: Sas7Context, pageIndex: number): Uint8Array {
  const start = ctx.header.headerSize + pageIndex * ctx.header.pageSize;
  const end = start + ctx.header.pageSize;
  if (end > ctx.bytes.length) throw new ParseError('SAS7BDAT page extends beyond file length.', { pageIndex });
  return ctx.bytes.subarray(start, end);
}

function readPageType(ctx: Sas7Context, page: Uint8Array): number {
  return readInt16(page, ctx.header.pageHeaderSize - 8, ctx.header.littleEndian);
}

function readSubheaderPointerCount(ctx: Sas7Context, page: Uint8Array): number {
  return readInt16(page, ctx.header.pageHeaderSize - 4, ctx.header.littleEndian);
}

function mixedPageDataOffset(ctx: Sas7Context, page: Uint8Array, pointers: SubheaderPointer[]): number {
  const offset = ctx.header.pageHeaderSize + pointers.length * ctx.header.subheaderPointerSize;
  if (offset % 8 !== 4 || offset + 4 > page.length) return offset;
  const padding = page.subarray(offset, offset + 4);
  const hasKnownPadding = padding.every((byte) => byte === 0x00) || padding.every((byte) => byte === 0x20);
  return hasKnownPadding || ctx.header.vendor !== 'stat-transfer' ? offset + 4 : offset;
}

function decompressRle(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;
  const commandLengths = [1, 1, 0, 0, 2, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0];
  while (inputOffset < input.length) {
    const control = input[inputOffset++] ?? 0;
    const command = (control & 0xf0) >> 4;
    const length = control & 0x0f;
    if (inputOffset + (commandLengths[command] ?? 0) > input.length) throw new ParseError('SAS7BDAT RLE stream is truncated.');
    let copyLength = 0;
    let insertLength = 0;
    let insertByte = 0;
    switch (command) {
      case 0: copyLength = (input[inputOffset++] ?? 0) + 64 + length * 256; break;
      case 1: copyLength = (input[inputOffset++] ?? 0) + 64 + length * 256 + 4096; break;
      case 2: copyLength = length + 96; break;
      case 4: insertLength = (input[inputOffset++] ?? 0) + 18 + length * 256; insertByte = input[inputOffset++] ?? 0; break;
      case 5: insertLength = (input[inputOffset++] ?? 0) + 17 + length * 256; insertByte = 0x40; break;
      case 6: insertLength = (input[inputOffset++] ?? 0) + 17 + length * 256; insertByte = 0x20; break;
      case 7: insertLength = (input[inputOffset++] ?? 0) + 17 + length * 256; insertByte = 0x00; break;
      case 8: copyLength = length + 1; break;
      case 9: copyLength = length + 17; break;
      case 10: copyLength = length + 33; break;
      case 11: copyLength = length + 49; break;
      case 12: insertByte = input[inputOffset++] ?? 0; insertLength = length + 3; break;
      case 13: insertByte = 0x40; insertLength = length + 2; break;
      case 14: insertByte = 0x20; insertLength = length + 2; break;
      case 15: insertByte = 0x00; insertLength = length + 2; break;
    }
    if (copyLength) {
      if (outputOffset + copyLength > outputLength || inputOffset + copyLength > input.length) throw new ParseError('SAS7BDAT RLE copy exceeds stream bounds.');
      output.set(input.subarray(inputOffset, inputOffset + copyLength), outputOffset);
      inputOffset += copyLength;
      outputOffset += copyLength;
    }
    if (insertLength) {
      if (outputOffset + insertLength > outputLength) throw new ParseError('SAS7BDAT RLE insert exceeds output length.');
      output.fill(insertByte, outputOffset, outputOffset + insertLength);
      outputOffset += insertLength;
    }
  }
  if (outputOffset !== outputLength) throw new ParseError('SAS7BDAT RLE output length mismatch.', { outputOffset, outputLength });
  return output;
}

function decompressRdc(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;
  while (inputOffset + 2 <= input.length) {
    const prefix = ((input[inputOffset] ?? 0) << 8) + (input[inputOffset + 1] ?? 0);
    inputOffset += 2;
    for (let bit = 0; bit < 16; bit += 1) {
      if ((prefix & (1 << (15 - bit))) === 0) {
        if (inputOffset >= input.length) break;
        if (outputOffset >= outputLength) throw new ParseError('SAS7BDAT RDC literal exceeds output length.');
        output[outputOffset++] = input[inputOffset++] ?? 0;
        continue;
      }
      if (inputOffset + 2 > input.length) throw new ParseError('SAS7BDAT RDC stream is truncated.');
      const markerByte = input[inputOffset++] ?? 0;
      const nextByte = input[inputOffset++] ?? 0;
      let insertLength = 0;
      let copyLength = 0;
      let insertByte = 0;
      let backOffset = 0;
      if (markerByte <= 0x0f) {
        insertLength = 3 + markerByte;
        insertByte = nextByte;
      } else if ((markerByte >> 4) === 1) {
        if (inputOffset >= input.length) throw new ParseError('SAS7BDAT RDC stream is truncated.');
        insertLength = 19 + (markerByte & 0x0f) + nextByte * 16;
        insertByte = input[inputOffset++] ?? 0;
      } else if ((markerByte >> 4) === 2) {
        if (inputOffset >= input.length) throw new ParseError('SAS7BDAT RDC stream is truncated.');
        copyLength = 16 + (input[inputOffset++] ?? 0);
        backOffset = 3 + (markerByte & 0x0f) + nextByte * 16;
      } else {
        copyLength = markerByte >> 4;
        backOffset = 3 + (markerByte & 0x0f) + nextByte * 16;
      }
      if (insertLength) {
        if (outputOffset + insertLength > outputLength) throw new ParseError('SAS7BDAT RDC insert exceeds output length.');
        output.fill(insertByte, outputOffset, outputOffset + insertLength);
        outputOffset += insertLength;
      } else if (copyLength) {
        if (outputOffset < backOffset || copyLength > backOffset || outputOffset + copyLength > outputLength) {
          throw new ParseError('SAS7BDAT RDC copy is invalid.');
        }
        output.copyWithin(outputOffset, outputOffset - backOffset, outputOffset - backOffset + copyLength);
        outputOffset += copyLength;
      }
    }
  }
  if (outputOffset !== outputLength) throw new ParseError('SAS7BDAT RDC output length mismatch.', { outputOffset, outputLength });
  return output;
}

function mapSasEncoding(code: number): string {
  const map: Record<number, string> = {
    0: 'windows-1252',
    20: 'utf-8',
    28: 'us-ascii',
    29: 'iso-8859-1',
    30: 'iso-8859-2',
    31: 'iso-8859-3',
    32: 'iso-8859-4',
    33: 'iso-8859-5',
    34: 'iso-8859-6',
    35: 'iso-8859-7',
    36: 'iso-8859-8',
    37: 'iso-8859-9',
    40: 'iso-8859-15',
    60: 'windows-1250',
    61: 'windows-1251',
    62: 'windows-1252',
    63: 'windows-1253',
    64: 'windows-1254',
    65: 'windows-1255',
    66: 'windows-1256',
    67: 'windows-1257',
    68: 'windows-1258',
    125: 'gb18030',
    126: 'windows-936',
    138: 'shift_jis',
  };
  return map[code] ?? 'windows-1252';
}

function decodeFileFormat(value: number | undefined): string | undefined {
  if (value === '1'.charCodeAt(0)) return 'unix';
  if (value === '2'.charCodeAt(0)) return 'windows';
  return value ? String.fromCharCode(value) : undefined;
}

function parseMajorVersion(release?: string): number | undefined {
  if (!release) return undefined;
  const major = release[0];
  if (major && major >= '1' && major <= '9') return Number(major);
  if (major === 'V') return 9;
  return undefined;
}

function parseMinorRevision(release?: string): { minor: number; revision: number } | undefined {
  if (!release) return undefined;
  const match = release.match(/^[1-9V]\.(\d{4})[MJ](\d)/u);
  if (!match) return undefined;
  return { minor: Number(match[1]), revision: Number(match[2]) };
}

function sasDateTimeToIso(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds === 0) return undefined;
  const unixMillis = (seconds - 3653 * 86400) * 1000;
  const date = new Date(unixMillis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
