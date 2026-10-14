import type { Message } from '../types/message'
import { getMessageText, hasRenderableContent, isAbortedMessage, isUserMessage } from '../types/message'

const FULL_TITLE_MAX = 80

export interface OutlineSourceEntry {
  messageId: string
  title: string
}

/** 独立轮次大纲的条目：在标题基础上带创建时间，供跨分页累积后稳定排序 */
export interface TurnOutlineEntry {
  messageId: string
  title: string
  createdAt: number
}

/** 从一条用户消息的原始文本里取标题：优先 summary.title，否则首行非空文本 */
function deriveOutlineTitle(rawTitle: string | undefined, text: string): string | undefined {
  const raw =
    rawTitle?.trim() ||
    text
      .trim()
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
  if (!raw) return undefined
  return truncate(normalizeWhitespace(raw), FULL_TITLE_MAX)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '\u2026'
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function messageHasContent(msg: Message): boolean {
  const hasRenderable = hasRenderableContent(msg)
  if (msg.info.role === 'assistant' && 'error' in msg.info && msg.info.error) {
    return isAbortedMessage(msg.info) ? hasRenderable : true
  }
  if (msg.content.length === 0) return true
  return hasRenderable
}

export function truncateOutlineLabel(s: string, max: number): string {
  return truncate(s, max)
}

export function buildOutlineSourceEntries(messages: Message[]): OutlineSourceEntry[] {
  const entries: OutlineSourceEntry[] = []
  for (const msg of messages.filter(messageHasContent)) {
    if (!isUserMessage(msg.info)) continue
    const title = deriveOutlineTitle(msg.info.summary?.title, getMessageText(msg))
    if (!title) continue
    entries.push({ messageId: msg.info.id, title })
  }
  return entries
}

/**
 * 从一批消息里提取轮次大纲条目（带创建时间）。
 *
 * 与 buildOutlineSourceEntries 不同，这里不要求消息「有可渲染内容」——
 * 独立大纲可能只拿到轻量投影，甚至只拿到 user 元信息，只要有标题就收。
 * 供 turnOutlineStore 跨分页累积使用。
 */
export function extractTurnOutlineEntries(messages: Message[]): TurnOutlineEntry[] {
  const entries: TurnOutlineEntry[] = []
  for (const msg of messages) {
    if (!isUserMessage(msg.info)) continue
    const title = deriveOutlineTitle(msg.info.summary?.title, getMessageText(msg))
    if (!title) continue
    entries.push({
      messageId: msg.info.id,
      title,
      createdAt: msg.info.time?.created ?? 0,
    })
  }
  return entries
}
