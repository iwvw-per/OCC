/**
 * 回归：切后台再回前台后，助手消息不能整段消失。
 *
 * 真实场景（移动端）：App 进后台 → 网络断开 → 回前台触发 network 重连 →
 * `loadSession(force)` 用服务端快照整段替换本地消息。而快照天然只覆盖一个窗口
 * （v2 单次 limit 上限 200；骨架首屏只有最近几页）。
 *
 * 先前的 localOnly 只保留「流式中 / 未定稿」的本地消息，窗口之外已定稿的历史
 * 被整段丢掉 —— 用户看到的就是「切回来后只剩自己的消息，Agent 的回复全没了」。
 */
import { describe, expect, it } from 'vitest'
import { mergeWithLocalStreamingMessages } from './useSessionManager'
import type { ApiMessageWithParts } from '../api/types'
import type { Message } from '../types/message'
import type { SessionState } from '../store/messageStoreTypes'

function apiAssistant(id: string, created: number, text: string): ApiMessageWithParts {
  return {
    info: {
      id,
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created, completed: created + 1 },
      finish: 'stop',
    },
    parts: [{ id: `${id}-t`, sessionID: 'ses-1', messageID: id, type: 'text', text }],
  } as unknown as ApiMessageWithParts
}

function uiAssistant(id: string, created: number, text: string): Message {
  return {
    info: {
      id,
      sessionID: 'ses-1',
      role: 'assistant',
      parentID: 'u',
      modelID: 'm',
      providerID: 'p',
      mode: '',
      agent: 'build',
      path: { cwd: '', root: '' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created + 1 },
      finish: 'stop',
    },
    content: [{ id: `${id}-t`, sessionID: 'ses-1', messageID: id, type: 'text', text }],
    isStreaming: false,
  } as unknown as Message
}

function localState(messages: Message[], streaming = false): SessionState {
  return { messages, isStreaming: streaming } as unknown as SessionState
}

describe('mergeWithLocalStreamingMessages', () => {
  it('keeps finished local messages that fall outside the server snapshot window', () => {
    // 本地有 3 条历史（都已定稿），服务端快照只回了最后 1 条
    const local = [
      uiAssistant('a1', 1000, 'old 1'),
      uiAssistant('a2', 2000, 'old 2'),
      uiAssistant('a3', 3000, 'recent'),
    ]
    const snapshot = [apiAssistant('a3', 3000, 'recent')]

    const merged = mergeWithLocalStreamingMessages(snapshot, localState(local))
    const ids = merged.map(m => m.info.id)

    expect(ids).toEqual(['a1', 'a2', 'a3'])
    expect(merged).toHaveLength(3)
  })

  it('still lets the server snapshot win for messages it does contain', () => {
    const local = [uiAssistant('a1', 1000, 'local stale text')]
    const snapshot = [apiAssistant('a1', 1000, 'server authoritative')]

    const merged = mergeWithLocalStreamingMessages(snapshot, localState(local))
    expect(merged).toHaveLength(1)
    const part = merged[0].parts[0] as { text?: string }
    expect(part.text).toBe('server authoritative')
  })

  it('preserves skeleton stats for local-only turns so their fold stays visible', () => {
    // 骨架轮：正文已被剥掉，只有压缩统计撑着可见性
    const skeletonTurn = {
      ...uiAssistant('a1', 1000, ''),
      isCompressed: true,
      compressedStats: { reasoningCount: 3, stepCount: 7 },
    } as unknown as Message

    const merged = mergeWithLocalStreamingMessages([], localState([skeletonTurn]))
    expect(merged).toHaveLength(1)
    expect((merged[0] as unknown as { lightweight?: unknown }).lightweight).toEqual({
      reasoningCount: 3,
      stepCount: 7,
    })
  })

  it('returns the snapshot untouched when there is no local state', () => {
    const snapshot = [apiAssistant('a1', 1000, 'x')]
    expect(mergeWithLocalStreamingMessages(snapshot, undefined)).toEqual(snapshot)
  })
})
