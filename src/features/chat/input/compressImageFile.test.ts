import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compressImageFile } from './inputUtils'

/**
 * 图片附件压缩。
 *
 * 用户报「打开超大会话要十几秒」，实测 92% 的传输量是一张 inline 图片：
 * 1018KB 的 PNG base64 后 1358KB，光下载就要 9 秒。
 *
 * 根因是压缩链上有一条捷径：
 *   `if (scale === 1 && file.size < THRESHOLD*2) return original`
 * 那张图 2000×1078 未超上限（scale=1）、1018KB 刚好小于 1024KB，于是被原样
 * 放行 —— 而它转 WebP 后只有 76KB（省 93%）。
 *
 * 这组测试锁住两条契约：
 *   1. 超过阈值的 PNG 一律尝试重编码，不再因为「无需缩放」而跳过；
 *   2. 重编码结果确实更大时，仍回退原图（不能为了压缩把体积搞大）。
 */

const FAKE_DATA_URL = 'data:image/png;base64,AAAA'

beforeEach(() => {
  // 每个用例自己安装桩；这里不做全局覆盖
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 构造一个只带 size/type 的假 File（compressImageFile 只读这两个属性和 name） */
function fakeFile(size: number, type = 'image/png'): File {
  return { size, type, name: 'image.png' } as File
}

/**
 * 安装压缩链需要的浏览器 API 桩。
 * 返回控制句柄，可决定编码结果大小。
 */
function installCompressionStubs(encodedSize: number) {
  const blob = { size: encodedSize, arrayBuffer: async () => new ArrayBuffer(encodedSize) }

  vi.stubGlobal('createImageBitmap', async () => ({
    width: 2000,
    height: 1078,
    close: () => {},
  }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
      }
      getContext() {
        return { drawImage: () => {} }
      }
      async convertToBlob() {
        return blob
      }
    },
  )
  // readFileAsDataUrl 走 FileReader；这里直接给一个固定 data URL。
  // 注意 onload 必须收到 { target: { result } } —— 实现里读的是 e.target.result。
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | null = null
      onload: ((e: { target: { result: string } }) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      readAsDataURL() {
        this.result = FAKE_DATA_URL
        queueMicrotask(() => this.onload?.({ target: { result: FAKE_DATA_URL } }))
      }
    },
  )

  return { blob }
}

describe('compressImageFile', () => {
  it('re-encodes a large PNG even when no downscaling is needed', async () => {
    // 1018KB：旧实现在「scale===1 且 < 1024KB」时直接返回原图
    installCompressionStubs(76 * 1024)

    const result = await compressImageFile(fakeFile(1018 * 1024))

    // 必须走完编码，产出 WebP，而不是原样返回 PNG
    expect(result.mime).toBe('image/webp')
    expect(result.dataUrl.startsWith('data:image/webp;base64,')).toBe(true)
  })

  it('keeps the original when the encoded result is not smaller', async () => {
    // 编码结果比原图大：必须回退原图，不能把附件撑大
    installCompressionStubs(2 * 1024 * 1024)

    const result = await compressImageFile(fakeFile(300 * 1024))

    expect(result.mime).toBe('image/png')
    expect(result.dataUrl).toBe(FAKE_DATA_URL)
  })

  it('skips compression for small images below the threshold', async () => {
    installCompressionStubs(10 * 1024)

    const result = await compressImageFile(fakeFile(50 * 1024))

    expect(result.mime).toBe('image/png')
    expect(result.dataUrl).toBe(FAKE_DATA_URL)
  })

  it('keeps GIF and SVG as-is (not re-encodable)', async () => {
    installCompressionStubs(10 * 1024)

    const gif = await compressImageFile(fakeFile(2 * 1024 * 1024, 'image/gif'))
    expect(gif.mime).toBe('image/gif')
    const svg = await compressImageFile(fakeFile(2 * 1024 * 1024, 'image/svg+xml'))
    expect(svg.mime).toBe('image/svg+xml')
  })
})
