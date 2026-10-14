// ============================================
// turnCompression - 历史轮次的轻量投影
//
// 旧轮次（超出「最近 N 轮」窗口）的思考与工具过程占据内存大头：
//   - reasoning.text：整段思考，单条可达数十 KB
//   - tool.state.output：命令/文件内容，单条截断上限 256KB
//   - tool.state.metadata.diff / filediff.patch：整轮 patch 全文
//
// 压缩保留渲染与统计必需的最小字段：
//   - 文本 part：原样保留（最终回复）
//   - step-finish：原样保留（统计）
//   - tool part：保留 tool/callID/status/title/time/input，metadata 只留
//     文件路径与增删行数（供「改动文件」胶囊），剥掉 diff 正文与输出
//   - reasoning part：整条丢弃，数量记入 compressedStats
//
// 展开对应过程折叠块时按需回拉完整 parts（见 messageStore.hydrateMessages）。
// ============================================

import type { Content, ToolContent } from '../types/message'

/** tool.state 中体积最大、渲染折叠态不需要的字段 */
const HEAVY_TOOL_STATE_KEYS = ['output', 'error', 'raw', 'attachments'] as const
/** tool.state.metadata 中体积最大的 diff 正文 */
const HEAVY_METADATA_KEYS = ['diff', 'output'] as const
/** metadata.filediff 内的大字段 */
const HEAVY_FILEDIFF_KEYS = ['patch', 'before', 'after', 'diff'] as const

export interface CompressedMessageContent {
  content: Content[]
  reasoningCount: number
  stepCount: number
}

function stripToolState(state: ToolContent['state']): ToolContent['state'] {
  const next: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) }
  for (const key of HEAVY_TOOL_STATE_KEYS) delete next[key]

  const metadata = next.metadata
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const nextMetadata: Record<string, unknown> = { ...(metadata as Record<string, unknown>) }
    for (const key of HEAVY_METADATA_KEYS) delete nextMetadata[key]

    const filediff = nextMetadata.filediff
    if (filediff && typeof filediff === 'object' && !Array.isArray(filediff)) {
      const nextFilediff: Record<string, unknown> = { ...(filediff as Record<string, unknown>) }
      for (const key of HEAVY_FILEDIFF_KEYS) delete nextFilediff[key]
      nextMetadata.filediff = nextFilediff
    }

    const files = nextMetadata.files
    if (Array.isArray(files)) {
      nextMetadata.files = files.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
        const nextEntry: Record<string, unknown> = { ...(entry as Record<string, unknown>) }
        for (const key of ['diff', 'patch', 'before', 'after']) delete nextEntry[key]
        return nextEntry
      })
    }

    next.metadata = nextMetadata
  }

  return next as unknown as ToolContent['state']
}

/**
 * 压缩单条 assistant 消息的 content。
 * 返回原 content 引用表示没有可压缩内容（避免无谓拷贝）。
 */
export function compressMessageParts(content: Content[]): CompressedMessageContent {
  let reasoningCount = 0
  let stepCount = 0
  let changed = false

  const next: Content[] = []
  for (const part of content) {
    if (part.type === 'reasoning') {
      reasoningCount += 1
      changed = true
      continue
    }
    if (part.type === 'tool') {
      stepCount += 1
      const stripped = stripToolState(part.state)
      if (stripped !== part.state) {
        next.push({ ...part, state: stripped })
        changed = true
        continue
      }
    }
    next.push(part)
  }

  return {
    content: changed ? next : content,
    reasoningCount,
    stepCount,
  }
}
