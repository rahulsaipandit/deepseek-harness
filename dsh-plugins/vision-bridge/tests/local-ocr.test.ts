import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectOcrPlatform, LocalOcrError, LocalOcrUnavailableError, ocrCommand, runLocalOcr } from '../src/local-ocr.ts'

describe('detectOcrPlatform', () => {
  it('recognizes win32 and darwin', () => {
    expect(detectOcrPlatform('win32')).toBe('win32')
    expect(detectOcrPlatform('darwin')).toBe('darwin')
  })

  it('has no backend for linux or anything else', () => {
    expect(detectOcrPlatform('linux')).toBeUndefined()
    expect(detectOcrPlatform('aix')).toBeUndefined()
  })
})

describe('ocrCommand', () => {
  it('builds a fixed powershell argv for windows, with the image path as a plain trailing argument', () => {
    const scriptsDir = 'C:\\scripts'
    const { command, args } = ocrCommand('win32', 'C:\\Users\\me\\pic.png', scriptsDir)
    expect(command).toBe('powershell')
    expect(args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scriptsDir, 'ocr-windows.ps1'), 'C:\\Users\\me\\pic.png'])
  })

  it('builds a fixed swift argv for macos', () => {
    const scriptsDir = '/opt/scripts'
    const { command, args } = ocrCommand('darwin', '/tmp/pic.png', scriptsDir)
    expect(command).toBe('swift')
    expect(args).toEqual([join(scriptsDir, 'ocr-macos.swift'), '/tmp/pic.png'])
  })

  it('never interpolates the image path into the command string (argv stays an array)', () => {
    const malicious = '"; rm -rf / #'
    const { args } = ocrCommand('darwin', malicious, '/opt/scripts')
    // The path is one array element, never concatenated into a shell string.
    expect(args.at(-1)).toBe(malicious)
    expect(args.length).toBe(2)
  })
})

describe('runLocalOcr', () => {
  it('throws LocalOcrUnavailableError on a platform with no backend', async () => {
    await expect(runLocalOcr('/tmp/pic.png', { platform: 'linux' })).rejects.toThrow(LocalOcrUnavailableError)
  })

  it('returns trimmed stdout from the injected execFile implementation', async () => {
    const text = await runLocalOcr('/tmp/pic.png', {
      platform: 'darwin',
      execFileImpl: async () => ({ stdout: '  hello world  \n' }),
    })
    expect(text).toBe('hello world')
  })

  it('throws LocalOcrError when the recognizer produces no text', async () => {
    await expect(runLocalOcr('/tmp/pic.png', {
      platform: 'darwin',
      execFileImpl: async () => ({ stdout: '   ' }),
    })).rejects.toThrow(LocalOcrError)
  })

  it('wraps a subprocess failure as LocalOcrError', async () => {
    await expect(runLocalOcr('/tmp/pic.png', {
      platform: 'win32',
      execFileImpl: async () => { throw new Error('engine unavailable') },
    })).rejects.toThrow(/offline OCR failed/)
  })
})
