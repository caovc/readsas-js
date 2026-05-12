import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: {
        'readsas-js': resolve(import.meta.dirname, 'src/index.ts'),
        node: resolve(import.meta.dirname, 'src/node.ts'),
      },
      name: 'ReadSas',
      fileName: (format, entryName) =>
        entryName === 'node' ? `node.${format === 'cjs' ? 'cjs' : 'js'}` : `readsas-js.${format === 'cjs' ? 'cjs' : 'js'}`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['node:fs/promises'],
    },
    sourcemap: false,
  },
  test: {
    environment: 'node',
  },
});
