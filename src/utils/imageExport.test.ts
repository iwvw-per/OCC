// 验证「导出消息为图片」的懒加载与保存行为。
//
// html-to-image 改为在动作发生时 `await import(...)`(此前静态导入会让它
// 随消息渲染器进入首屏包)。这里断言:调用时确实动态加载并调用 toPng,
// 且把解码后的字节按 `PNG` 交给 saveData。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toPngMock, saveDataMock } = vi.hoisted(() => ({
  toPngMock: vi.fn(),
  saveDataMock: vi.fn(),
}))

vi.mock('html-to-image', () => ({ toPng: toPngMock }))
vi.mock('./downloadUtils', () => ({ saveData: saveDataMock }))

import { exportNodeAsImage } from './imageExport'

describe('exportNodeAsImage', () => {
  beforeEach(() => {
    toPngMock.mockReset()
    saveDataMock.mockReset()
  })

  it('动态加载 html-to-image 并把 PNG 字节交给 saveData', async () => {
    // "AQID" -> 字节 [1,2,3]
    toPngMock.mockResolvedValue('data:image/png;base64,AQID')

    const node = document.createElement('div')
    await exportNodeAsImage(node, { fileName: 'shot' })

    expect(toPngMock).toHaveBeenCalledTimes(1)
    expect(toPngMock.mock.calls[0][0]).toBe(node)
    expect(saveDataMock).toHaveBeenCalledTimes(1)
    const [bytes, fileName, mime] = saveDataMock.mock.calls[0]
    expect(Array.from(bytes)).toEqual([1, 2, 3])
    expect(fileName).toBe('shot.png')
    expect(mime).toBe('image/png')
  })

  it('已带 .png 后缀的文件名不重复追加', async () => {
    toPngMock.mockResolvedValue('data:image/png;base64,AQID')

    await exportNodeAsImage(document.createElement('div'), { fileName: 'a.png' })

    expect(saveDataMock.mock.calls[0][1]).toBe('a.png')
  })
})
