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

import { createSession, deleteSession, updateSession } from '../api/session'
import { getSessionMessages, sendMessage } from '../api/message'
import type { ApiSession, ApiMessageWithParts } from '../api/types'
import type { ModelInfo } from '../types/ui'
import { markEphemeralSession, unmarkEphemeralSession } from './ephemeralSessions'
import { getModelKey } from './modelUtils'
import { serverStorage } from './perServerStorage'
import { STORAGE_KEY_SELECTED_MODEL } from '../constants'
import { aiRenameModelStore } from '../store/aiRenameModelStore'
import { sessionListIndexStore } from '../store/sessionListIndexStore'
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
    const stored = serverStorage.getJSON<string[]>(HIDDEN_MODELS_STORAGE_KEY)
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
    serverId ? serverStorage.getFor(STORAGE_KEY_SELECTED_MODEL, serverId) : serverStorage.get(STORAGE_KEY_SELECTED_MODEL)
  const rememberedModel = pick(remembered)
  if (rememberedModel && !hidden.has(getModelKey(rememberedModel))) return rememberedModel

  if (visible.length > 0) return visible[0]
  return models[0]
}

/** 最长等待模型回复文本的时间 */
const MAX_REPLY_WAIT_MS = 60_000
const REPLY_POLL_MS = 800

/**
 * 从临时会话读回模型回复。v1 的 prompt 同步返回体已带完整 parts；v2 网关的
 * prompt 同步返回体不含 parts，因此退化为「轮询会话消息拿到最新助手文本」。
 */
async function fetchReplyText(
  sessionId: string,
  directory: string | undefined,
  serverId: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + MAX_REPLY_WAIT_MS
  let messages: ApiMessageWithParts[] = []

  const readOnce = async (): Promise<ApiMessageWithParts[]> => {
    try {
      return await getSessionMessages(sessionId, 8, directory, serverId)
    } catch {
      return []
    }
  }

  // 先立即读一次，避免 v1 已同步完成时还白等一轮
  messages = await readOnce()
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const assistantTexts = messages
      .filter(m => m.info.role === 'assistant')
      .map(extractText)
      .filter(Boolean)
    if (assistantTexts.length > 0) {
      // 取最后一条助手消息的文本（流式过程中后到的才是完整版）
      return assistantTexts[assistantTexts.length - 1]
    }
    await new Promise(resolve => setTimeout(resolve, REPLY_POLL_MS))
    messages = await readOnce()
  }
  return ''
}

/**
 * 生成并写回会话标题。返回新标题；无可用内容时返回 null。
 */
export async function generateSessionTitle(
  session: ApiSession,
  options: AiRenameOptions,
): Promise<string | null> {
  const { directory, serverId, model, signal } = options

  let messages: ApiMessageWithParts[] = []
  try {
    messages = await getSessionMessages(session.id, undefined, directory ?? session.directory, serverId)
  } catch {
    return null
  }
  const context = buildContext(messages)
  if (!context) return null

  signal?.throwIfAborted()

  const temp = await createSession({ directory: directory ?? session.directory }, serverId)
  markEphemeralSession(temp.id)
  // SSE 的 session.created 可能与 createSession 的响应竞态：若事件先到、临时会话
  // 已进索引桶，这里按「已删除」语义从所有桶摘掉并记墓碑，保证绝不露面。
  const sid = serverId ?? serverStore.getActiveServerId()
  sessionListIndexStore.applyDeleted(sid, temp.id)
  try {
    const response = await sendMessage(
      {
        sessionId: temp.id,
        text: `${TITLE_SYSTEM_PROMPT}\n\nConversation to title:\n\n${context}`,
        attachments: [],
        model: { providerID: model.providerId, modelID: model.id },
        directory: directory ?? session.directory,
      },
      serverId,
    )
    const rawFromSync = response.parts
      .filter(part => (part as { type?: string }).type === 'text')
      .map(part => (part as { text?: string }).text ?? '')
      .join('\n')
    const raw = (rawFromSync.trim() ? rawFromSync : await fetchReplyText(temp.id, directory, serverId, signal)).trim()
    const title = cleanTitle(raw)
    if (!title) return null
    await updateSession(session.id, { title }, directory ?? session.directory, serverId)
    return title
  } finally {
    unmarkEphemeralSession(temp.id)
    void deleteSession(temp.id, directory ?? session.directory, serverId).catch(() => {})
  }
}