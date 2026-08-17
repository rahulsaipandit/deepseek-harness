import { defineConfig, mergeConfig } from 'vite'
import { root, sharedConfig } from './vite.shared.ts'

export default defineConfig(mergeConfig(sharedConfig, {
  build: {
    lib: {
      entry: `${root}src/content/index.ts`,
      formats: ['iife'],
      name: 'dshBrowserBridgeContent',
      fileName: () => 'content.js',
    },
    rollupOptions: { output: { entryFileNames: 'content.js' } },
  },
}))
