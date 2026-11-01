import { describe, expect, it } from 'vitest'
import { resolveUnsettledTurnIds } from './useSessionManager'

/**
 * 新设备打开已有会话时，正在跑的最后一轮要按完整消息补拉。
 *
 * 实测（2026-11-01，ARM 主机 ses_eaa3442ccffeFLuqH2Vt3aN9TA）：最后一轮 92 步
 * 全部 completed、骨架 `reply: null`、后端没标 `settled: false`，而
 * `/api/session/active` 里该会话是 running。结果新设备上这一轮只剩折叠块 ——
 * 用户看到的就是「正在处理的消息显示不全，只显示最新几条」。
 */
describe('resolveUnsettledTurnIds', () => {
  it('后端已标记的轮次原样保留', () => {
    expect(resolveUnsettledTurnIds(['turn-a'], 'turn-b', false)).toEqual(['turn-a'])
  })

  it('会话仍在运行 + 末轮未被后端标记 → 补上末轮', () => {
    expect(resolveUnsettledTurnIds([], 'turn-b', true)).toEqual(['turn-b'])
    expect(resolveUnsettledTurnIds(undefined, 'turn-b', true)).toEqual(['turn-b'])
  })

  it('会话已空闲 → 不补拉（纯工具轮 / 中断轮的 reply 同样是 null）', () => {
    expect(resolveUnsettledTurnIds([], 'turn-b', false)).toEqual([])
    expect(resolveUnsettledTurnIds(undefined, 'turn-b', false)).toEqual([])
  })

  it('末轮已在后端标记里 → 不重复添加', () => {
    expect(resolveUnsettledTurnIds(['turn-b'], 'turn-b', true)).toEqual(['turn-b'])
  })

  it('没有末轮（骨架里没有 turn）→ 返回原标记', () => {
    expect(resolveUnsettledTurnIds(['turn-a'], undefined, true)).toEqual(['turn-a'])
    expect(resolveUnsettledTurnIds(undefined, undefined, true)).toEqual([])
  })
})
