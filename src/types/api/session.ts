import type {
  Session as SDKSession,
  SessionListData as SDKSessionListData,
  SessionStatus as SDKSessionStatus,
} from '@opencode-ai/sdk/v2/client'

export type SessionStatus = SDKSessionStatus

export type SessionStatusMap = Record<string, SessionStatus>



export type SessionRevert = NonNullable<SDKSession['revert']>

/**
 * 会话对象。
 *
 * 在 SDK 的 `Session` 之上补齐三个**服务端确实返回、但 SDK 2.0.28 类型里缺失**
 * 的字段（`packages/schema/src/session.ts` 的 `Session.Info` 有它们）：
 *
 * - `time.idle`   ：最近一次跑完的时间，是「已读水位」的比较基准
 * - `time.viewed` ：用户最后观察到哪一次 idle（v2 session.view 写入）
 * - `outcome`     ：上一轮的结论 succeeded / failed / interrupted
 *
 * 未读语义因此是 `viewed < idle`。不补这三个字段，任何跨端已读判断都做不了 ——
 * 之前 OCC 只能在本机通知表里维护未读点，换设备就完全不同步。
 */
export type Session = SDKSession & {
  time: SDKSession['time'] & {
    idle?: number
    viewed?: number
    archived?: number
  }
  outcome?: 'succeeded' | 'failed' | 'interrupted'
}

export type SessionListParams = NonNullable<SDKSessionListData['query']>



