import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vite'

export const root = fileURLToPath(new URL('.', import.meta.url))

export const sharedConfig: UserConfig = {
  root,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
  },
}
