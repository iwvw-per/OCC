// ============================================
// subagentUtils — 子代理（task）工具识别
//
// v1 里派生子代理的工具叫 `task`；v2/OMO 里叫 `subagent`（显示为 Subagent）。
// 之前各处只判 `=== 'task'`，导致 v2 的子代理被当成普通工具渲染。
//
// 另外 v2 的子会话 id 不一定在 `state.metadata.sessionId`，而是嵌在工具输出里：
//   <subagent sessionID="ses_xxx" state="completed"> ... </subagent>
// 这里统一从 metadata / 输出里取。
// ============================================

import type { ToolPart } from '../../types/message'

const SUBAGENT_TOOL_NAMES = new Set(['task', 'subagent', 'sub_agent', 'task_agent'])

/** 该工具名是否是「派生子代理」的工具（task / subagent ...）。 */
export function isSubagentToolName(name: string | undefined | null): boolean {
  if (!name) return false
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase())
}

// 子会话 id 在输出里的几种形态：
//   1. 结构化：<subagent sessionID="ses_xxx" state="completed"> ... </subagent>
//   2. v2 后台子代理的纯文本回执：
//      "The subagent is working in the background (sessionID: ses_xxx). ..."
// 第 2 种仅在确认是「后台子代理回执」时才解析（见 isBackgroundSubagentOutput），
// 避免裸 `sessionID:` 文本误匹配到无关内容。
const STRUCTURED_SUBAGENT_SESSION_RE = /<subagent\b[^>]*\bsessionID\s*=\s*"([^"]+)"/i
const BACKGROUND_SESSION_RE = /\bsessionID\s*[:=]\s*"?([A-Za-z0-9_-]+)"?/i

const BACKGROUND_SUBAGENT_RE = /\bworking in the background\b/i

/** 该工具输出是否是「已转入后台运行」的 v2 子代理回执。 */
export function isBackgroundSubagentOutput(output: unknown): boolean {
  return typeof output === 'string' && BACKGROUND_SUBAGENT_RE.test(output)
}

/** 从工具输出文本里解析子会话 id。 */
export function parseSubagentSessionId(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output) return undefined
  const structured = output.match(STRUCTURED_SUBAGENT_SESSION_RE)
  if (structured?.[1]) return structured[1]
  // 纯文本形态只对「后台子代理回执」生效，避免把任意 sessionID 文本当成子会话。
  if (!isBackgroundSubagentOutput(output)) return undefined
  const background = output.match(BACKGROUND_SESSION_RE)
  return background?.[1] || undefined
}

/**
 * 取该工具 part 关联的子会话 id（原始 id，未复合 server 前缀）。
 * 优先 `state.metadata.sessionId`，回退到从输出里解析。
 */
export function getSubagentSessionId(part: ToolPart): string | undefined {
  if (!isSubagentToolName(part.tool)) return undefined
  const metadata = part.state.metadata as Record<string, unknown> | undefined
  const fromMetadata = metadata?.sessionId
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata
  return parseSubagentSessionId(part.state.output)
}
