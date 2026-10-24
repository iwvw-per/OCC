import { describe, expect, it } from 'vitest'
import { toUIMessage, toApiMessageWithParts } from './messageConversion'
import type { ApiMessageWithParts } from '../api/types'

function envelope(extra: Record<string, unknown> = {}): ApiMessageWithParts {
  return {
    info: { id: 'a1', sessionID: 'ses-1', role: 'assistant', time: { created: 1 } },
    parts: [{ id: 't1', sessionID: 'ses-1', messageID: 'a1', type: 'text', text: 'hi' }],
    ...extra,
  } as unknown as ApiMessageWithParts
}

describe('toUIMessage lightweight mapping', () => {
  it('marks messages with a lightweight field as compressed with stats', () => {
    const message = toUIMessage(envelope({ lightweight: { reasoningCount: 2, stepCount: 3 } }))
    expect(message.isCompressed).toBe(true)
    expect(message.compressedStats).toEqual({ reasoningCount: 2, stepCount: 3 })
  })

  it('leaves normal messages uncompressed', () => {
    const message = toUIMessage(envelope())
    expect(message.isCompressed).toBeUndefined()
    expect(message.compressedStats).toBeUndefined()
  })

  it('defaults missing lightweight counts to zero', () => {
    const message = toUIMessage(envelope({ lightweight: {} }))
    expect(message.isCompressed).toBe(true)
    expect(message.compressedStats).toEqual({ reasoningCount: 0, stepCount: 0 })
  })
})

/**
 * 回归：本地消息合并回快照时，压缩统计必须原样带回。
 *
 * 骨架轮的正文已被主机 Agent 剥掉，可见性完全依赖 `compressedStats`
 * （`hasSkeletonProcessStats`）。先前 `toApiMessageWithParts` 只搬了
 * info + parts，`lightweight` 在往返中丢失 —— 消息一旦经过
 * `mergeWithLocalStreamingMessages` 的 localOnly 分支（切后台再回前台、
 * 重连后 force 重载都会走到），折叠壳消失，整轮 assistant 变成不可见，
 * 界面上只剩用户消息。
 */
describe('toApiMessageWithParts preserves lightweight stats', () => {
  it('round-trips compressedStats through the API envelope', () => {
    const ui = toUIMessage(envelope({ lightweight: { reasoningCount: 5, stepCount: 9, durationMs: 1234 } }))
    expect(ui.compressedStats).toEqual({ reasoningCount: 5, stepCount: 9, durationMs: 1234 })

    const back = toApiMessageWithParts(ui) as ApiMessageWithParts & {
      lightweight?: { reasoningCount: number; stepCount: number; durationMs?: number }
    }
    expect(back.lightweight).toEqual({ reasoningCount: 5, stepCount: 9, durationMs: 1234 })

    // 再转回 UI 仍然可见（可见性依赖 compressedStats 存在）
    expect(toUIMessage(back).compressedStats).toEqual({ reasoningCount: 5, stepCount: 9, durationMs: 1234 })
  })

  it('does not invent a lightweight field for normal messages', () => {
    const ui = toUIMessage(envelope())
    const back = toApiMessageWithParts(ui) as ApiMessageWithParts & { lightweight?: unknown }
    expect(back.lightweight).toBeUndefined()
  })

  it('keeps skeletonChangedFiles across the round trip', () => {
    const ui = toUIMessage(
      envelope({
        lightweight: {
          reasoningCount: 0,
          stepCount: 2,
          changedFiles: [{ path: 'a.ts', additions: 3, deletions: 1 }],
        },
      }),
    )
    const back = toApiMessageWithParts(ui) as ApiMessageWithParts & {
      lightweight?: { changedFiles?: Array<{ path: string }> }
    }
    expect(back.lightweight?.changedFiles?.[0]?.path).toBe('a.ts')
  })
})
