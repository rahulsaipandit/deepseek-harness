/**
 * Bearer-token lifecycle for the web-terminal WebSocket route: generation,
 * constant-time verification, and file persistence under the dsh home
 * directory. Single-operator scope only — matching the confirmed single-user
 * DSH posture (see `docs/designCabinetButForSingleUser.md`), this is not a
 * multi-user accounts system, just a shared secret gating an otherwise
 * unauthenticated route (`ctx.webServer`'s README: "No TLS, auth, or origin
 * policy … is deliberately out of scope").
 *
 * Adapted from `dsh-plugin-browser-bridge`'s `token.ts` (same design), kept
 * as its own copy since these are independent, standalone `dsh-plugins/`
 * packages by convention.
 * @module dsh-plugin-web-terminal/token
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** File name of the persisted token inside the dsh home. */
export const TOKEN_FILE_NAME = 'web-terminal-token'

/** Generate a fresh token as lowercase hex (256-bit by default). */
export function generateToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex')
}

/** Constant-time token comparison; a length mismatch fails fast and never verifies. */
export function verifyToken(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/** Path of the persisted token file under the dsh home, e.g. `~/.dsh/web-terminal-token`. */
export function tokenFilePath(): string {
  return dshHomePath(TOKEN_FILE_NAME)
}

/** Read the persisted token; returns undefined when absent or unreadable. */
export async function readTokenFile(file: string = tokenFilePath()): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/** Persist a token atomically (temp file + rename) with 0600 permissions. */
export async function writeTokenFile(token: string, file: string = tokenFilePath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${token}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, file)
}

/**
 * Resolve the route token: an explicitly configured token wins; otherwise the
 * persisted file is reused when present, and a fresh token is generated and
 * persisted otherwise.
 */
export async function resolveToken(
  configured: string | undefined,
  file: string = tokenFilePath(),
): Promise<{ token: string; file: string; generated: boolean }> {
  if (configured !== undefined && configured.length > 0) {
    return { token: configured, file, generated: false }
  }
  const persisted = await readTokenFile(file)
  if (persisted !== undefined && persisted.length > 0) return { token: persisted, file, generated: false }
  const token = generateToken()
  await writeTokenFile(token, file)
  return { token, file, generated: true }
}
