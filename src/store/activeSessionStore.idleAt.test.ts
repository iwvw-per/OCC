import { describe, expect, it } from 'vitest'
import { activeSessionStore } from './activeSessionStore'

/**
 * 回归（2026-10-31 实测）：「回复已经写完，界面却一直显示处理中」。
 *
 * 现场（本机 127.0.0.1:4096，opencode 2.x）：
 *   22:47 `/api/session/active` 同时报两个会话 running
 *   而 `GET /api/session/{id}` 里 `time.idle` 已存在且早得多：
 *     ses_e73dbf… idle=1793456303944 outcome=interrupted
 *     ses_e6e0b3… idle=1793457422703 outcome=succeeded
 * 两条的最后一条 assistant 也都已 `completed`。
 *
 * 也就是说 `/api/session/active` 会残留：只要过程中有一条 assistant 缺
 * `time.completed`，该会话就一直挂在 running 里。前端若无条件采信它，
 * `isSessionRunning` 永远为 true → 折叠块不收、状态栏一直「处理中」。
 *
 * 因此要能区分「active 说在跑」和「它其实早就收到过权威 idle」。
 * 这里固定住记录侧的原语（判定逻辑在 fetchActiveScopeData 里使用）。
 */

describe('activeSessionStore 的权威 idle 记录', () => {
  it('登记后可读出 idle 时间，且只前进不后退', () => {
    const key = 'test::ses_idle_at'
    activeSessionStore.setSessionIdleAt(key, 2000)
    expect(activeSessionStore.getSessionMeta(key)?.idleAt).toBe(2000)

    // 旧结论不能把新结论覆盖回去（乱序到达的 idle 不应让会话「复忙」）
    activeSessionStore.setSessionIdleAt(key, 1000)
    expect(activeSessionStore.getSessionMeta(key)?.idleAt).toBe(2000)

    activeSessionStore.setSessionIdleAt(key, 3000)
    expect(activeSessionStore.getSessionMeta(key)?.idleAt).toBe(3000)
  })

  it('登记 idle 不会冲掉已有的标题与目录', () => {
    const key = 'test::ses_meta_keep'
    activeSessionStore.setSessionMeta(key, '某个会话', '/opt/code/temp')
    activeSessionStore.setSessionIdleAt(key, 1234)
    const meta = activeSessionStore.getSessionMeta(key)
    expect(meta?.title).toBe('某个会话')
    expect(meta?.directory).toBe('/opt/code/temp')
    expect(meta?.idleAt).toBe(1234)
  })

  it('批量写入 meta 时 idleAt 与 title/directory 一并保留', () => {
    const key = 'test::ses_bulk'
    activeSessionStore.setSessionMetaBulk([{ sessionId: key, title: 't', directory: '/d', idleAt: 555 }])
    const meta = activeSessionStore.getSessionMeta(key)
    expect(meta).toMatchObject({ title: 't', directory: '/d', idleAt: 555 })
  })
})
