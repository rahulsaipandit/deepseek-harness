import { defineConfig, mergeConfig } from 'vite'
import { root, sharedConfig } from './vite.shared.ts'

export default defineConfig(mergeConfig(sharedConfig, {
  build: {
    emptyOutDir: true,
    lib: {
      entry: `${root}src/background/index.ts`,
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: { output: { entryFileNames: 'background.js' } },
  },
}))
