// ============================================
// v2 原生 Message 访问层
//
// 直接用 @opencode/client（v2 原生）调用消息相关接口，
// 不经过 clientFacade 的 v1→v2 facade 层。
// ============================================

import { getV2Client } from './sdkV2'
import type { ApiMessageWithParts } from './types'
import { adaptMessagePage } from './v2/message'

export interface V2PromptInput {
  sessionID: string
  text?: string
  parts?: unknown[]
  model?: { providerID: string; modelID: string }
  agent?: string
  messageID?: string
}

/** 把 v1 形状的 prompt parts 转成 v2 的 { text, files[], agents[] }（与 facade 一致） */
function buildV2Prompt(input: V2PromptInput): { text: string; files?: Array<{ uri: string; name?: string }>; agents?: Array<{ name: string }> } {
  const textChunks: string[] = []
  const files: Array<{ uri: string; name?: string }> = []
  const agents: Array<{ name: string }> = []
  for (const raw of input.parts ?? []) {
    const p = raw as { type?: string; text?: string; url?: string; uri?: string; filename?: string; name?: string }
    if (p.type === 'text' && p.text) textChunks.push(p.text)
    else if (p.type === 'file') {
      const uri = p.url ?? p.uri
      if (uri) files.push({ uri, name: p.filename ?? p.name })
    } else if (p.type === 'agent' && p.name) agents.push({ name: p.name })
  }
  const text = textChunks.length > 0 ? textChunks.join('\n') : (input.text ?? '')
  return { text, files: files.length > 0 ? files : undefined, agents: agents.length > 0 ? agents : undefined }
}

/**
 * 原生发送消息（v2 session.prompt）。
 * model 先 switchModel（v2 用 {providerID, id}），再 prompt。
 */
export async function nativePrompt(serverId: string | undefined, input: V2PromptInput): Promise<unknown> {
  const client = getV2Client(serverId)
  if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
  if (input.model) await client.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } })
  const prompt = buildV2Prompt(input)
  const res = await client.session.prompt({
    sessionID: input.sessionID,
    id: input.messageID,
    text: prompt.text,
    files: prompt.files as never,
    agents: prompt.agents as never,
  })
  return res
}

/**
 * 原生拉取消息页（v2 message.list，cursor 分页）。
 * 返回适配回 ApiMessageWithParts[] + 双向游标；messages 一律按时间升序。
 *
 * ⚠️ v2 `message.list` 的排序语义（与 v1 相反，必须显式处理）：
 * - 默认 order = `desc`（**最新在前**），并非升序；
 * - 传 `cursor` 时不能再叠加 `order`（会 400），方向由 cursor 自身携带；
 * - `cursor.next` 指向**更早**一侧。
 *
 * 官方 `@opencode/client` 的用法正是「显式 order=desc + `data.toReversed()`」。
 * 这里对齐：首页取 desc 后反转成升序，续页只用 cursor（返回仍是 desc）再反转。
 * 返回的 nextCursor 供调用方继续向前（更早）翻页。
 */
export async function nativeListMessages(
  serverId: string | undefined,
  input: { sessionID: string; limit?: number; cursor?: string; order?: 'desc'; headers?: Record<string, string> },
): Promise<{ messages: ApiMessageWithParts[]; nextCursor?: string; prevCursor?: string }> {
  const client = getV2Client(serverId)
  const page = adaptMessagePage(
    await client.message.list(
      {
        sessionID: input.sessionID,
        limit: input.limit,
        cursor: input.cursor,
        // 有 cursor 时不能传 order（服务端 400）；首页显式 desc，与官方客户端一致。
        ...(input.cursor ? {} : { order: input.order ?? 'desc' }),
      },
      input.headers ? { headers: input.headers } : undefined,
    ),
  )
  // desc（最新在前）→ 升序（时间正序），与前端渲染顺序一致。
  return { ...page, messages: [...page.messages].reverse() }
}
