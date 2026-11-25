import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const getFileContentMock = vi.fn()
const getSessionMetaMock = vi.fn()

vi.mock('../api/file', () => ({
  getFileContent: (...args: unknown[]) => getFileContentMock(...args),
}))

vi.mock('../store/activeSessionStore', () => ({
  activeSessionStore: {
    getSessionMeta: (...args: unknown[]) => getSessionMetaMock(...args),
  },
}))

import {
  REMOTE_ATTACHMENT_MAX_BYTES,
  clearRemoteAttachmentImageCache,
  isDirectlyLoadableUrl,
  resolveAttachmentHostPath,
  useRemoteAttachmentImage,
} from './useRemoteAttachmentImage'

beforeEach(() => {
  getFileContentMock.mockReset()
  getSessionMetaMock.mockReset()
  getSessionMetaMock.mockReturnValue(undefined)
  clearRemoteAttachmentImageCache()
})

describe('isDirectlyLoadableUrl', () => {
  it('treats data/http/blob as directly loadable', () => {
    expect(isDirectlyLoadableUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isDirectlyLoadableUrl('https://example.com/a.png')).toBe(true)
    expect(isDirectlyLoadableUrl('http://example.com/a.png')).toBe(true)
    expect(isDirectlyLoadableUrl('blob:https://example.com/x')).toBe(true)
  })

  it('treats file:// and bare paths as not loadable', () => {
    expect(isDirectlyLoadableUrl('file:///home/u/a.png')).toBe(false)
    expect(isDirectlyLoadableUrl('/home/u/a.png')).toBe(false)
    expect(isDirectlyLoadableUrl(undefined)).toBe(false)
  })
})

describe('resolveAttachmentHostPath', () => {
  it('decodes POSIX file:// URLs', () => {
    expect(resolveAttachmentHostPath('file:///home/u/my%20shot.png')).toBe('/home/u/my shot.png')
  })

  it('handles Windows file:// URLs with drive letters', () => {
    expect(resolveAttachmentHostPath('file:///C:/Users/u/shot.png')).toBe('/C:/Users/u/shot.png')
  })

  it('handles file:// with a host segment', () => {
    expect(resolveAttachmentHostPath('file://nas/share/shot.png')).toBe('/share/shot.png')
  })

  it('accepts absolute raw paths', () => {
    expect(resolveAttachmentHostPath('/home/u/a.png')).toBe('/home/u/a.png')
    expect(resolveAttachmentHostPath('C:\\Users\\u\\a.png')).toBe('C:\\Users\\u\\a.png')
  })

  it('falls back to relativePath when url has no usable path', () => {
    expect(resolveAttachmentHostPath(undefined, '/home/u/a.png')).toBe('/home/u/a.png')
  })

  it('returns null for http/data urls and bare filenames', () => {
    expect(resolveAttachmentHostPath('https://example.com/a.png')).toBeNull()
    expect(resolveAttachmentHostPath('data:image/png;base64,AAAA')).toBeNull()
    expect(resolveAttachmentHostPath('shot.png')).toBeNull()
    expect(resolveAttachmentHostPath(undefined)).toBeNull()
  })
})

describe('useRemoteAttachmentImage', () => {
  it('returns the url as-is for directly loadable sources without fetching', () => {
    const { result } = renderHook(() =>
      useRemoteAttachmentImage({ url: 'https://example.com/a.png', serverId: 'aiagent:inst_work' }),
    )
    expect(result.current).toBe('https://example.com/a.png')
    expect(getFileContentMock).not.toHaveBeenCalled()
  })

  it('reads the file from the origin host and converts to a data URL', async () => {
    getFileContentMock.mockResolvedValue({
      type: 'binary',
      encoding: 'base64',
      mimeType: 'image/png',
      content: 'iVBORw0KGgo=',
    })

    const { result } = renderHook(() =>
      useRemoteAttachmentImage({
        url: 'file:///home/u/shot.png',
        mime: 'image/png',
        serverId: 'aiagent:inst_work',
        sessionId: 'ses-1',
      }),
    )

    await waitFor(() => expect(result.current).toBe('data:image/png;base64,iVBORw0KGgo='))
    expect(getFileContentMock).toHaveBeenCalledWith('/home/u/shot.png', undefined, 'aiagent:inst_work')
  })

  it('uses the session directory as the read location when available', async () => {
    getSessionMetaMock.mockReturnValue({ directory: '/repo' })
    getFileContentMock.mockResolvedValue({
      type: 'binary',
      encoding: 'base64',
      mimeType: 'image/png',
      content: 'AAAA',
    })

    const { result } = renderHook(() =>
      useRemoteAttachmentImage({
        url: 'file:///repo/shot.png',
        serverId: 'aiagent:inst_work',
        sessionId: 'ses-1',
      }),
    )

    await waitFor(() => expect(result.current).toBe('data:image/png;base64,AAAA'))
    expect(getSessionMetaMock).toHaveBeenCalledWith('aiagent:inst_work::ses-1')
    expect(getFileContentMock).toHaveBeenCalledWith('/repo/shot.png', '/repo', 'aiagent:inst_work')
  })

  it('returns null (fallback to file chip) when the read fails', async () => {
    getFileContentMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() =>
      useRemoteAttachmentImage({ url: 'file:///home/u/shot.png', serverId: 'aiagent:inst_work' }),
    )
    await waitFor(() => expect(getFileContentMock).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('skips fetching when no serverId is known', async () => {
    const { result } = renderHook(() => useRemoteAttachmentImage({ url: 'file:///home/u/shot.png' }))
    expect(result.current).toBeNull()
    expect(getFileContentMock).not.toHaveBeenCalled()
  })

  it('caches a successful read by server/path', async () => {
    getFileContentMock.mockResolvedValue({
      type: 'binary',
      encoding: 'base64',
      mimeType: 'image/png',
      content: 'AAAA',
    })

    const input = { url: 'file:///home/u/shot.png', serverId: 'aiagent:inst_work', sessionId: 'ses-1' }
    const first = renderHook(() => useRemoteAttachmentImage(input))
    await waitFor(() => expect(first.result.current).toBe('data:image/png;base64,AAAA'))
    first.unmount()

    const second = renderHook(() => useRemoteAttachmentImage(input))
    await waitFor(() => expect(second.result.current).toBe('data:image/png;base64,AAAA'))
    expect(getFileContentMock).toHaveBeenCalledTimes(1)
  })

  it('drops oversized images', async () => {
    const huge = 'A'.repeat(Math.ceil((REMOTE_ATTACHMENT_MAX_BYTES * 4) / 3) + 16)
    getFileContentMock.mockResolvedValue({
      type: 'binary',
      encoding: 'base64',
      mimeType: 'image/png',
      content: huge,
    })
    const { result } = renderHook(() =>
      useRemoteAttachmentImage({ url: 'file:///home/u/huge.png', serverId: 'aiagent:inst_work' }),
    )
    await waitFor(() => expect(getFileContentMock).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})
