/**
 * Build all extension targets sequentially into dist/: background (es) ->
 * content (iife) -> panel (plain HTML/TS). The first target cleans dist; the
 * later ones append.
 *
 * Ported (structure only) from github.com/Lum1104/dsh-browser
 * (`extensions/dsh-browser/scripts/build.mjs`), simplified for this port's
 * three targets (no React panel bundle).
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cp, mkdir } from 'node:fs/promises'

const root = fileURLToPath(new URL('..', import.meta.url))

const configs = [
  'vite.background.config.ts',
  'vite.content.config.ts',
  'vite.panel.config.ts',
]

for (const config of configs) {
  const result = spawnSync('npx', ['vite', 'build', '--config', config], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

await mkdir(new URL('../dist/assets/icons', import.meta.url), { recursive: true }).catch(() => {})
await cp(new URL('../manifest.json', import.meta.url), new URL('../dist/manifest.json', import.meta.url))
