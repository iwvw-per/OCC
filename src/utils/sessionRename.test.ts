// ============================================
// AI 重命名：走 v2 session.generate，不再创建临时会话
// ============================================
//
// 旧实现为了拿一段标题文本，要「建临时会话 → 发消息 → 轮询读回复 → 删会话」，
// 4 个往返，还要靠 ephemeralSessions + 索引墓碑把临时会话从侧栏藏起来（和 SSE
// 的 session.created 竞态）。这里锁住新语义：不创建任何会话，只发一次 generate。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMessages = vi.fn()
const updateSession = vi.fn()
const generateSessionText = vi.fn()
const generateText = vi.fn()
const createSession = vi.fn()
const deleteSession = vi.fn()

vi.mock('../api/message', () => ({ getSessionMessages }))
vi.mock('../api/session', () => ({ updateSession, createSession, deleteSession }))
vi.mock('../api/v2NativeSession', () => ({
  nativeGenerateSessionText: generateSessionText,
  nativeGenerateText: generateText,
}))
vi.mock('../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => 'local' },
}))
vi.mock('../utils/perServerStorage', () => ({
  serverStorage: { getJSON: () => null, getJSONFor: () => null, get: () => null, getFor: () => null },
}))
vi.mock('../store/aiRenameModelStore', () => ({
  aiRenameModelStore: { get: () => null, getFor: () => null },
}))

const { generateSessionTitle } = await import('./sessionRename')

const session = {
  id: 'ses_1',
  directory: '/repo',
  time: { created: 1, updated: 1 },
  location: { directory: '/repo' },
} as never

const model = { id: 'm1', providerId: 'p1' } as never

function userMessage(text: string) {
  return {
    info: { role: 'user', id: `msg_${text}` },
    parts: [{ type: 'text', text }],
  }
}

describe('generateSessionTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMessages.mockResolvedValue([userMessage('重构图片上传')])
    updateSession.mockResolvedValue({})
  })

  it('用 session.generate 生成标题，不创建临时会话', async () => {
    generateSessionText.mockResolvedValue('图片上传重构')
    const title = await generateSessionTitle(session, { model })

    expect(title).toBe('图片上传重构')
    expect(generateSessionText).toHaveBeenCalledOnce()
    // 关键回归点：全程不得创建/删除临时会话
    expect(createSession).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
    // 标题必须写回原会话
    expect(updateSession).toHaveBeenCalledWith('ses_1', { title: '图片上传重构' }, '/repo', undefined)
  })

  it('generate 的 prompt 里带上对话内容', async () => {
    generateSessionText.mockResolvedValue('t')
    await generateSessionTitle(session, { model })
    const prompt = generateSessionText.mock.calls[0][1].prompt as string
    expect(prompt).toContain('重构图片上传')
    expect(prompt).toContain('only title it')
  })

  it('session.generate 失败时退回无上下文的一次性生成', async () => {
    generateSessionText.mockRejectedValue(new Error('unsupported'))
    generateText.mockResolvedValue('退回标题')

    const title = await generateSessionTitle(session, { model })
    expect(title).toBe('退回标题')
    expect(generateText).toHaveBeenCalledOnce()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('两者都失败时返回 null，且不写回标题', async () => {
    generateSessionText.mockRejectedValue(new Error('a'))
    generateText.mockRejectedValue(new Error('b'))

    expect(await generateSessionTitle(session, { model })).toBeNull()
    expect(updateSession).not.toHaveBeenCalled()
  })

  it('没有可用对话内容时直接返回 null，不发请求', async () => {
    getSessionMessages.mockResolvedValue([])
    expect(await generateSessionTitle(session, { model })).toBeNull()
    expect(generateSessionText).not.toHaveBeenCalled()
  })

  it('清理模型输出里的引号/前缀', async () => {
    generateSessionText.mockResolvedValue('  "标题：修复 bug"  ')
    const title = await generateSessionTitle(session, { model })
    expect(title).not.toMatch(/^["'\s]/)
    expect(title).toContain('修复 bug')
  })
})
