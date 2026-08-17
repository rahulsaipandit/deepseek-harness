import { defineConfig, mergeConfig } from 'vite'
import { root, sharedConfig } from './vite.shared.ts'

export default defineConfig(mergeConfig(sharedConfig, {
  build: {
    rollupOptions: {
      input: `${root}panel/index.html`,
    },
  },
}))
