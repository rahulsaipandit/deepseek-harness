/**
 * Offline OCR fallback for when no vision API key is configured or every
 * configured provider failed — the other genuinely useful idea from
 * visionDS (`docs/adr/rp_dshPlugins.md`'s review): Windows' built-in WinRT
 * OCR engine, or macOS's Vision framework, both free and requiring no
 * network call or API key.
 *
 * Kept to the same safe subprocess shape visionDS itself used correctly:
 * `execFile` with an argument array, never a shell string — no injection
 * surface from the image path. Unlike visionDS's skill script, nothing here
 * accepts a model-supplied command override; the two bundled scripts are the
 * only commands this module ever runs.
 * @module dsh-plugin-vision-bridge/local-ocr
 */

import { execFile as execFileCallback } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export class LocalOcrUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalOcrUnavailableError'
  }
}

export class LocalOcrError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LocalOcrError'
  }
}

export type OcrPlatform = 'win32' | 'darwin'

/** Local OCR is only wired up for Windows (WinRT OCR) and macOS (Vision) today — no Linux backend exists. */
export function detectOcrPlatform(platform: NodeJS.Platform): OcrPlatform | undefined {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'darwin'
  return undefined
}

export const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')

/** Build the fixed argv for one platform's OCR script; never a shell string. */
export function ocrCommand(platform: OcrPlatform, imagePath: string, scriptsDir: string = SCRIPTS_DIR): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scriptsDir, 'ocr-windows.ps1'), imagePath],
    }
  }
  return { command: 'swift', args: [join(scriptsDir, 'ocr-macos.swift'), imagePath] }
}

export interface ExecFileResult {
  stdout: string
}

/** Injection point for tests; defaults to the real `child_process.execFile`. */
export type ExecFileFn = (command: string, args: string[], options: { timeout: number, windowsHide: boolean, maxBuffer: number }) => Promise<ExecFileResult>

const defaultExecFile: ExecFileFn = promisify(execFileCallback) as unknown as ExecFileFn

export interface LocalOcrOptions {
  timeoutMs?: number
  platform?: NodeJS.Platform
  scriptsDir?: string
  execFileImpl?: ExecFileFn
}

/** Run offline OCR against a local image file path. Never falls back silently to a wrong/empty result — a failure or empty read is a thrown error. */
export async function runLocalOcr(imagePath: string, options: LocalOcrOptions = {}): Promise<string> {
  const platform = detectOcrPlatform(options.platform ?? process.platform)
  if (platform === undefined) {
    throw new LocalOcrUnavailableError('offline OCR fallback is only implemented for Windows and macOS')
  }
  const { command, args } = ocrCommand(platform, imagePath, options.scriptsDir)
  const execFileImpl = options.execFileImpl ?? defaultExecFile
  try {
    const { stdout } = await execFileImpl(command, args, {
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    const text = stdout.trim()
    if (text.length === 0) throw new LocalOcrError('offline OCR recognized no text in the image')
    return text
  } catch (error: unknown) {
    if (error instanceof LocalOcrError) throw error
    throw new LocalOcrError(`offline OCR failed: ${String(error instanceof Error ? error.message : error)}`, { cause: error })
  }
}
