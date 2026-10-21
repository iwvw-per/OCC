// ============================================
// sessionRename — 使用模型自动生成会话标题
// ============================================
//
// 没有专用的「生成标题」端点，这里用现有能力拼装：
// 1. 创建一个临时会话（不进入侧栏索引，用完即删）；
// 2. 把最近若干轮对话压缩成提示词，要求模型只输出一行标题；
// 3. 从临时会话读回模型回复文本，清理后写回原标题；
// 4. 无论成败都删除临时会话。
//
// 为什么不直接在被命名会话里发消息：那会在对话历史里留下一条无关的用户
// 消息和回复，污染上下文。临时会话互不影响。
//
// 临时会话通过 utils/ephemeralSessions 登记，SSE 事件与列表索引据此把它
// 挡在侧栏列表、搜索结果、会话导航等所有用户可见的会话视图之外。

import { updateSession } from '../api/session'
import { getSessionMessages } from '../api/message'
import { nativeGenerateSessionText, nativeGenerateText } from '../api/v2NativeSession'
import type { ApiSession, ApiMessageWithParts } from '../api/types'
import type { ModelInfo } from '../types/ui'
import { getModelKey } from './modelUtils'
import { serverStorage } from './perServerStorage'
import { STORAGE_KEY_SELECTED_MODEL } from '../constants'
import { aiRenameModelStore } from '../store/aiRenameModelStore'
import { serverStore } from '../store/serverStore'

const MAX_TITLE_LENGTH = 60
const MAX_TURNS = 3
const MAX_CHARS_PER_TURN = 1200

const HIDDEN_MODELS_STORAGE_KEY = 'hidden-model-keys'

const TITLE_SYSTEM_PROMPT = [
  'You generate a concise conversation title.',
  'Output ONLY the title on a single line, no quotes, no markdown, no prefix.',
  'Use the same language as the most recent user message.',
  'At most 50 characters. Keep important technical terms, filenames and numbers.',
  'Do not answer questions in the conversation; only title it.',
].join(' ')

function extractText(message: ApiMessageWithParts): string {
  return message.parts
    .filter(part => part.type === 'text' && !(part as { synthetic?: boolean }).synthetic)
    .map(part => (part as { text?: string }).text ?? '')
    .join('\n')
    .trim()
}

function buildContext(messages: ApiMessageWithParts[]): string {
  const turns: string[] = []
  for (const message of messages) {
    const text = extractText(message)
    if (!text) continue
    const role = message.info.role === 'user' ? 'User' : 'Assistant'
    turns.push(`**${role}**\n${text.slice(0, MAX_CHARS_PER_TURN)}`)
  }
  return turns.slice(-MAX_TURNS * 2).join('\n\n---\n\n')
}

function cleanTitle(raw: string): string {
  const firstLine =
    raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0) ?? ''
  return firstLine
    .replace(/^["'`#*\s]+|["'`*\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TITLE_LENGTH)
    .trim()
}

export interface AiRenameOptions {
  directory?: string
  serverId?: string
  model: Pick<ModelInfo, 'id' | 'providerId'>
  signal?: AbortSignal
}

/**
 * 解析 AI 重命名实际使用的模型，优先级从高到低：
 * 1. 设置中显式指定的偏好模型（按服务器保存）；已隐藏则跳过
 * 2. 该服务器上记住的「当前所选模型」；已隐藏则跳过
 * 3. 第一个可见模型
 * 4. 列表里的第一个模型（兜底）
 */
export function resolveAiRenameModel(models: ModelInfo[], serverId?: string): ModelInfo | undefined {
  if (models.length === 0) return undefined

  const hidden = new Set<string>()
  if (serverId) {
    const stored = serverStorage.getJSONFor<string[]>(HIDDEN_MODELS_STORAGE_KEY, serverId)
    if (Array.isArray(stored)) stored.forEach(key => hidden.add(key))
  } else {
    const stored = serverStorage.getJSON<string[]>(HIDDEN_MODELS_STORAGE_KEY, serverStore.getActiveServerId())
    if (Array.isArray(stored)) stored.forEach(key => hidden.add(key))
  }
  const visible = models.filter(model => !hidden.has(getModelKey(model)))

  const pick = (key: string | null | undefined): ModelInfo | undefined => {
    if (!key) return undefined
    return models.find(model => getModelKey(model) === key)
  }

  const preferred = serverId ? aiRenameModelStore.getFor(serverId) : aiRenameModelStore.get()
  const preferredModel = pick(preferred)
  if (preferredModel && !hidden.has(getModelKey(preferredModel))) return preferredModel

  const remembered =
    serverId ? serverStorage.getFor(STORAGE_KEY_SELECTED_MODEL, serverId) : serverStorage.get(STORAGE_KEY_SELECTED_MODEL, serverStore.getActiveServerId())
  const rememberedModel = pick(remembered)
  if (rememberedModel && !hidden.has(getModelKey(rememberedModel))) return rememberedModel

  if (visible.length > 0) return visible[0]
  return models[0]
}

/**
 * 生成并写回会话标题。返回新标题；无可用内容时返回 null。
 *
 * 走 v2 `session.generate`：它**在会话上下文之上**做一次性生成，不写入历史、
 * 不产生事件、不占用会话。旧实现要「建临时会话 → 发消息 → 轮询读回复 → 删会话」
 * 四个往返，且临时会话必须靠 ephemeralSessions 登记 + 索引墓碑才能不露在侧栏里
 * （每生成一个标题都是一次和 SSE 的竞态）。现在只剩「取消息算上下文」+
 * 「一次 generate」+「写回标题」三步。
 */
export async function generateSessionTitle(
  session: ApiSession,
  options: AiRenameOptions,
): Promise<string | null> {
  const { directory, serverId, model, signal } = options
  const dir = directory ?? session.directory

  let messages: ApiMessageWithParts[] = []
  try {
    messages = await getSessionMessages(session.id, undefined, dir, serverId)
  } catch {
    return null
  }
  const context = buildContext(messages)
  if (!context) return null

  signal?.throwIfAborted()

  const sid = serverId ?? serverStore.getActiveServerId()
  let raw = ''
  try {
    raw = await nativeGenerateSessionText(sid, {
      sessionID: session.id,
      prompt: `${TITLE_SYSTEM_PROMPT}\n\nConversation to title:\n\n${context}`,
    })
  } catch {
    // session.generate 不可用（旧版服务端 / 该会话无可用模型）时退回无上下文的
    // 一次性生成：只把对话摘要作为 prompt，仍是一个往返。
    raw = await nativeGenerateText(sid, {
      prompt: `${TITLE_SYSTEM_PROMPT}\n\nConversation to title:\n\n${context}`,
      model: { providerID: model.providerId, id: model.id },
    }).catch(() => '')
  }

  signal?.throwIfAborted()
  const title = cleanTitle(raw)
  if (!title) return null
  await updateSession(session.id, { title }, dir, serverId)
  return title
}