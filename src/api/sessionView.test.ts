// ============================================
// 会话已读上报（v2 session.view）
// ============================================
//
// 这是把「未读」从纯本地状态升级为服务端水位的入口。关键约束：
// 1. 幂等：同一水位只发一次，否则每次焦点变化都会打一次网络。
// 2. 只升不降：更小的 idle 不发（服务端也会忽略，但没必要白跑一趟）。
// 3. 静默失败：上报失败不能影响打开会话。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const viewSession = vi.fn()

vi.mock('./v2NativeSession', () => ({ nativeViewSession: viewSession }))
vi.mock('../utils/sessionKey', () => ({
  sessionKeyToSessionId: (key: string) => key.slice(key.indexOf('::') + 2),
  sessionKeyToServerId: (key: string) => key.slice(0, key.indexOf('::')),
}))
vi.mock('../utils', () => ({ logger: { warn: vi.fn() } }))

const { reportSessionViewed, resetViewReportCache } = await import('./sessionView')

const KEY = 'local::ses_abc'

describe('reportSessionViewed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetViewReportCache()
    viewSession.mockResolvedValue(true)
  })

  it('把裸 sessionID 与水位数传给服务端', async () => {
    await reportSessionViewed(KEY, 1700000000000)
    expect(viewSession).toHaveBeenCalledWith('local', { sessionID: 'ses_abc', idle: 1700000000000 })
  })

  it('同一水位重复调用只发一次请求', async () => {
    await reportSessionViewed(KEY, 1000)
    await reportSessionViewed(KEY, 1000)
    await reportSessionViewed(KEY, 1000)
    expect(viewSession).toHaveBeenCalledOnce()
  })

  it('更新的水位会再发一次', async () => {
    await reportSessionViewed(KEY, 1000)
    await reportSessionViewed(KEY, 2000)
    expect(viewSession).toHaveBeenCalledTimes(2)
    expect(viewSession).toHaveBeenLastCalledWith('local', { sessionID: 'ses_abc', idle: 2000 })
  })

  it('更旧的水位不再发请求（只升不降）', async () => {
    await reportSessionViewed(KEY, 2000)
    await reportSessionViewed(KEY, 1000)
    expect(viewSession).toHaveBeenCalledOnce()
  })

  it('idle 缺省或非正数时直接跳过', async () => {
    await reportSessionViewed(KEY, undefined)
    await reportSessionViewed(KEY, 0)
    expect(viewSession).not.toHaveBeenCalled()
  })

  it('上报失败不抛错', async () => {
    viewSession.mockRejectedValue(new Error('boom'))
    await expect(reportSessionViewed(KEY, 1000)).resolves.toBeUndefined()
  })

  it('不同会话互不影响', async () => {
    await reportSessionViewed('local::ses_a', 1000)
    await reportSessionViewed('local::ses_b', 1000)
    expect(viewSession).toHaveBeenCalledTimes(2)
  })

  it('同一会话在不同主机上分别上报', async () => {
    await reportSessionViewed('local::ses_a', 1000)
    await reportSessionViewed('aiagent:inst_1::ses_a', 1000)
    expect(viewSession).toHaveBeenCalledTimes(2)
    expect(viewSession).toHaveBeenLastCalledWith('aiagent:inst_1', { sessionID: 'ses_a', idle: 1000 })
  })
})
