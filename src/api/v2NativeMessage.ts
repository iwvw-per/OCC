// ============================================
// v2 原生 Message 访问层
//
// 直接用 @opencode/client（v2 原生）调用消息相关接口。
// ============================================

import { getV2Client } from './sdkV2'
import type { ApiMessageWithParts } from './types'
import { adaptMessagePageAsync, type CompactionMarker } from './v2/message'

export interface V2PromptInput {
  sessionID: string
  text?: string
  parts?: unknown[]
  model?: { providerID: string; modelID: string }
  agent?: string
  messageID?: string
  /** 投递方式：steer（插队，缺省）/ queue（排到当前轮次之后） */
  delivery?: 'steer' | 'queue'
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
 *
 * ⚠️ 延迟敏感：这里绝不能串行发多个请求。
 *
 * v2 的 agent/model 是**会话级**状态。旧实现每次发送都串行做
 * 「switchAgent → switchModel → prompt」三次往返：本机各 2–7ms 看不出来，但经隧道
 * 连远程主机时每次约 1.1s，用户点发送后要等 2–3 秒才开始出字，于是以为没发出去、
 * 反复重发 —— 这正是「输入发送后停很久才出现回复」的直接原因。
 *
 * 改法：
 *   - 调用方先用会话元数据判断「服务端已经是这个 agent/model 了吗」，是则跳过对应
 *     switch，正常发送只剩 prompt 一次往返；
 *   - 确实需要切换时，两个 switch 并行发出，再发 prompt（必须等它们落定，否则这一轮
 *     会用旧 agent/model）。
 */
export async function nativePrompt(
  serverId: string | undefined,
  input: V2PromptInput & { skipAgentSwitch?: boolean; skipModelSwitch?: boolean },
): Promise<unknown> {
  const client = getV2Client(serverId)

  const switches: Array<Promise<unknown>> = []
  if (input.agent && !input.skipAgentSwitch) {
    switches.push(client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }))
  }
  if (input.model && !input.skipModelSwitch) {
    switches.push(
      client.session.switchModel({
        sessionID: input.sessionID,
        model: { providerID: input.model.providerID, id: input.model.modelID },
      }),
    )
  }
  if (switches.length > 0) await Promise.all(switches)

  const prompt = buildV2Prompt(input)
  const res = await client.session.prompt({
    sessionID: input.sessionID,
    id: input.messageID,
    text: prompt.text,
    files: prompt.files as never,
    agents: prompt.agents as never,
    // 缺省时由服务端按 steer 处理；显式传 queue 才是「排到本轮之后」。
    ...(input.delivery ? { delivery: input.delivery } : {}),
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
): Promise<{
  messages: ApiMessageWithParts[]
  nextCursor?: string
  prevCursor?: string
  compactedAt?: number
  compaction?: CompactionMarker
}> {
  const client = getV2Client(serverId)
  const res = await client.message.list(
    {
      sessionID: input.sessionID,
      limit: input.limit,
      cursor: input.cursor,
      // 有 cursor 时不能传 order（服务端 400）；首页显式 desc，与官方客户端一致。
      ...(input.cursor ? {} : { order: input.order ?? 'desc' }),
    },
    input.headers ? { headers: input.headers } : undefined,
  )
  // 分块适配：一页几千条时避免长时间占用主线程
  const page = await adaptMessagePageAsync(res)
  // desc（最新在前）→ 升序（时间正序），与前端渲染顺序一致。
  return { ...page, messages: [...page.messages].reverse() }
}
