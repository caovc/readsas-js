# readsas-js

TypeScript library for reading SAS-oriented data files into JSON-friendly metadata and records.

Supported now:

- Dataset-JSON single-dataset and multi-dataset containers
- SAS XPORT V5/V8 format detection and row parsing
- SAS XPORT libraries with one or more members
- SAS7BDAT metadata, columns, and rows
- Browser and Node.js entry points
- Caller-specified text encoding via `TextDecoder`

```ts
import { readSas } from 'readsas-js';

const result = await readSas(arrayBuffer, { encoding: 'windows-1252' });
console.log(result.meta);

for (const dataset of result.datasets) {
  console.log(dataset.meta);
  console.log(dataset.columns);
  console.log(dataset.records);
}
```

Node file helper:

```ts
import { readSasFile } from 'readsas-js/node';

const result = await readSasFile('./transport.xpt');
```

## API

- `readSas(input, options)` accepts `ArrayBuffer`, typed-array views, `Blob`, or a JSON string.
- `readSas(input, options)` returns `{ meta, datasets }`; `datasets` is always an array, even for single-table formats.
- `readSasDataset(input, options)` returns the first dataset when a caller wants the older single-table style.
- `detectSasFormat(bytes)` identifies `dataset-json`, `xport-v5`, `xport-v8`, or `sas7bdat` from file content instead of file extension.
- `options.format` can force a parser, otherwise auto-detection is used.
- `options.encoding` controls character decoding for labels, names, and string values.

## Build

```sh
npm install
npm run build
npm test
```
