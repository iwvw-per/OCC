// 回归：顶栏标题不能被「空/旧」快照覆盖。
//
// 用户报障（2026-11-11）：侧栏标题已经自动更新，但**顶栏一直显示「新对话」**，
// 必须整页刷新才恢复。
//
// 根因：顶栏读的是 messageStore 的 `state.title`，而 `setMessages` 会用
// `options.title`（来自 `GET /session` 快照）无条件覆盖它。真实时序是：
//
//   1. `session.created` 事件**不带 title**（实测真实事件流），
//      此刻 GET /session 返回的 title 是空串；
//   2. `session.renamed`（seq 6）比 `step.started`（seq 7）更早到达，
//      先把真标题写进 store；
//   3. 之前并发发出的 sessionInfo 请求这时才落地，带着空 title
//      把刚写好的新标题清掉。
//
// 修复：快照 title 为空时忽略；已被 renamed 定为权威时也不再被快照覆盖。

import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiMessageWithParts } from '../api/types'
import { messageStore } from './messageStore'

function userMsg(id: string): ApiMessageWithParts {
  return {
    info: {
      id,
      sessionID: 's',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'p', modelID: 'm', variant: 'default' },
    },
    parts: [{ id: `${id}-text`, sessionID: 's', messageID: id, type: 'text', text: id }],
  } as unknown as ApiMessageWithParts
}

describe('messageStore 标题不被快照降级', () => {
  beforeEach(() => {
    messageStore.clearSession('s')
  })

  it('空标题的快照不会清掉已有标题（新会话时序）', () => {
    // 1. renamed 先到，写入真标题
    messageStore.setMessages('s', [userMsg('m1')])
    messageStore.updateSessionMetadata('s', { title: '修复登录问题', titleAuthoritative: true })
    expect(messageStore.getSessionTitle('s')).toBe('修复登录问题')

    // 2. 早先发出的 GET /session 落地：title 为空（会话刚创建时还没有标题）
    messageStore.setMessages('s', [userMsg('m1')], { title: '' })

    expect(messageStore.getSessionTitle('s')).toBe('修复登录问题')
  })

  it('旧快照的 title 不会覆盖 renamed 写的权威标题', () => {
    messageStore.setMessages('s', [userMsg('m1')])
    messageStore.updateSessionMetadata('s', { title: '新标题', titleAuthoritative: true })

    // 15s TTL 缓存命中的旧快照晚到
    messageStore.setMessages('s', [userMsg('m1')], { title: '旧标题' })

    expect(messageStore.getSessionTitle('s')).toBe('新标题')
  })

  it('未标记权威时，非空快照标题照常写入（冷启动/刷新）', () => {
    messageStore.setMessages('s', [userMsg('m1')], { title: '来自快照的标题' })
    expect(messageStore.getSessionTitle('s')).toBe('来自快照的标题')

    // 服务端真的改名（非权威来源也能更新，用于刷新场景）
    messageStore.setMessages('s', [userMsg('m1')], { title: '改名后' })
    expect(messageStore.getSessionTitle('s')).toBe('改名后')
  })
})
