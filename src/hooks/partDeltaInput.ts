import type { PartDeltaPayload } from '../types/api/event'

/** `messageStore.handlePartDelta` 的入参(已归一到 store 索引用的形状)。 */
export interface PartDeltaInput {
  sessionID: string
  messageID: string
  partID: string
  /** 目标 part 字段。store 侧 `text` / `reasoning` 的正文都落在 part.text 上。 */
  field: 'text' | 'reasoning'
  delta: string
}

/**
 * `MESSAGE_PART_DELTA` 载荷 → store 入参。
 *
 * ⚠️ **必须优先用生产端给的 `partID`**。v2 映射(`api/v2/events.ts`)已经按
 * `${assistantMessageID}-{text|reasoning}-${ordinal}` 把 part id 拼好,但它
 * **不转发 `ordinal`**(只用于拼 partID)。旧实现用 `assistantMessageID` +
 * `ordinal` 重算,运行期 `ordinal` 恒为 `undefined`:
 *
 *   - text  → `msg_x-text-undefined`
 *   - reasoning → `undefined-text-undefined`(reasoning 分支连 messageID 都没发)
 *
 * store 按 part **id 精确匹配**(`getPartIndex` 没有兜底),匹配不上就进
 * `pendingDeltas`;回放同样按这个错 id 查找 → 增量**永久丢弃**,表现为
 * 「不流式、整段一次出现」。这里改为直接用 `partID`,只在缺 `partID` 的老形状下
 * 才回退到重算。
 */
export function toPartDeltaInput(data: PartDeltaPayload): PartDeltaInput | null {
  const sessionID = typeof data.sessionID === 'string' ? data.sessionID : ''
  if (!sessionID) return null

  const field = data.field === 'reasoning' ? 'reasoning' : 'text'
  const messageID =
    typeof data.messageID === 'string' && data.messageID.length > 0
      ? data.messageID
      : typeof data.assistantMessageID === 'string'
        ? data.assistantMessageID
        : ''

  const partID =
    typeof data.partID === 'string' && data.partID.length > 0
      ? data.partID
      : messageID
        ? `${messageID}-${field}-${typeof data.ordinal === 'number' ? data.ordinal : 0}`
        : ''
  if (!partID) return null

  return { sessionID, messageID, partID, field, delta: typeof data.delta === 'string' ? data.delta : '' }
}
