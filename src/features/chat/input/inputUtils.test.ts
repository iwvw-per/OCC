import { describe, expect, it } from 'vitest'
import { ensureFileMime, getMimeFromPath, isFileSupported, isTextLikeMime } from './inputUtils'
import type { FileCapabilities } from '../../../api'

/**
 * 附件能力判定。
 *
 * 真实故障（2026-11-02）：用户粘贴大段文本后选「作为附件」，得到
 * 「当前模型不支持 pasted-xxx.txt」。原因是 `isFileSupported` 只认
 * image/pdf/audio/video，而这条路径生成的正是 text/plain。
 *
 * 另一条证据：网关对 `text/markdown`、`text/plain`、`application/json`、
 * `application/octet-stream` 四种附件 MIME 的 prompt 均返回 200 —— 文本附件
 * 由服务端内联，不依赖模型的多模态能力。
 */

const TEXT_ONLY: FileCapabilities = { image: false, pdf: false, audio: false, video: false }
const VISION: FileCapabilities = { image: true, pdf: false, audio: false, video: false }

describe('isFileSupported', () => {
  it('accepts plain text even when the model has no multimodal capability', () => {
    expect(isFileSupported('text/plain', TEXT_ONLY)).toBe(true)
    expect(isFileSupported('text/markdown', TEXT_ONLY)).toBe(true)
  })

  it('accepts common application text types', () => {
    expect(isFileSupported('application/json', TEXT_ONLY)).toBe(true)
    expect(isFileSupported('application/xml', TEXT_ONLY)).toBe(true)
    expect(isFileSupported('application/x-yaml', TEXT_ONLY)).toBe(true)
  })

  it('accepts octet-stream (fallback for unknown extensions)', () => {
    expect(isFileSupported('application/octet-stream', TEXT_ONLY)).toBe(true)
  })

  it('still gates images on the model capability', () => {
    expect(isFileSupported('image/png', TEXT_ONLY)).toBe(false)
    expect(isFileSupported('image/png', VISION)).toBe(true)
  })

  it('honours text:false when a caller explicitly disables text attachments', () => {
    expect(isFileSupported('text/plain', { ...TEXT_ONLY, text: false })).toBe(false)
  })

  it('rejects genuinely unsupported binaries', () => {
    expect(isFileSupported('application/zip', TEXT_ONLY)).toBe(false)
    expect(isFileSupported('application/vnd.ms-excel', TEXT_ONLY)).toBe(false)
  })
})

describe('isTextLikeMime', () => {
  it('classifies text-ish mimes', () => {
    expect(isTextLikeMime('text/csv')).toBe(true)
    expect(isTextLikeMime('application/json')).toBe(true)
    expect(isTextLikeMime('image/png')).toBe(false)
  })
})

describe('text file extensions resolve to a supported mime', () => {
  it('maps md/txt/csv/log to text mimes', () => {
    expect(getMimeFromPath('D:\\workspace\\notes.md')).toBe('text/markdown')
    expect(getMimeFromPath('/tmp/a.txt')).toBe('text/plain')
    expect(getMimeFromPath('/tmp/a.csv')).toBe('text/csv')
    expect(getMimeFromPath('/tmp/a.log')).toBe('text/plain')
  })

  it('keeps unknown extensions as octet-stream (still accepted as text)', () => {
    expect(getMimeFromPath('/tmp/a.xyz')).toBe('application/octet-stream')
  })

  it('ensureFileMime fills the type for a .md File with empty type', () => {
    const file = new File(['# hi'], 'note.md', { type: '' })
    expect(ensureFileMime(file).type).toBe('text/markdown')
  })
})
