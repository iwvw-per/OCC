import type { Message, Content } from '../../types/message'
import { hasRenderableContent, isAbortedMessage, isVisibleReasoningContent, isVisibleTextContent } from '../../types/message'

function messageHasContent(message: Message): boolean {
  const hasRenderable = hasRenderableContent(message)
  // 有非 abort 错误的助手消息始终可见（展示错误信息）。
  // abort 只有在已经产生可见内容时才显示；空 abort 不占信息流位置。
  if (message.info.role === 'assistant' && 'error' in message.info && message.info.error) {
    return isAbortedMessage(message.info) ? hasRenderable : true
  }
  if (message.content.length === 0) {
    // 任何角色的空消息都不可见：没有内容可展示
    // content 到达后自动进入可见列表；abort 后永远不会有 content → 永远不可见
    return false
  }
  return hasRenderable
}

function isVisibleThinking(content: Content): boolean {
  return isVisibleReasoningContent(content)
}

function isVisibleText(content: Content): boolean {
  return isVisibleTextContent(content)
}

function endsWithTool(msg: Message): boolean {
  if (msg.info.role !== 'assistant' || msg.content.length === 0) return false
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const c = msg.content[i]
    // skip empty reasoning / empty text — they carry no visible content
    if (c.type === 'reasoning' && !isVisibleReasoningContent(c)) continue
    if (c.type === 'text' && !isVisibleTextContent(c)) continue
    return c.type === 'tool'
  }
  return false
}

function isToolOnlyFollowUp(msg: Message): boolean {
  if (msg.info.role !== 'assistant') return false
  let sawTool = false
  for (const c of msg.content) {
    if (isVisibleThinking(c) || isVisibleText(c)) return false
    if (c.type === 'tool') sawTool = true
  }
  return sawTool
}

function isMergeableTrailing(msg: Message): boolean {
  if (msg.info.role !== 'assistant') return false
  let sawTool = false
  let sawVisibleText = false
  for (const c of msg.content) {
    if (isVisibleThinking(c)) return false
    if (c.type === 'tool') {
      sawTool = true
      continue
    }
    if (isVisibleText(c)) {
      sawVisibleText = true
      continue
    }
  }
  return sawTool && sawVisibleText
}

export interface VisibleMessageEntry {
  message: Message
  sourceIds: string[]
}

export function getVisibleMessageForkTargetId(entry: VisibleMessageEntry): string {
  return entry.sourceIds[entry.sourceIds.length - 1] || entry.message.info.id
}

export function buildVisibleMessageEntries(messages: Message[]): VisibleMessageEntry[] {
  // 防御性去重：保证输入无重复 ID
  const seenIds = new Set<string>()
  const unique: Message[] = []
  for (const m of messages) {
    if (!seenIds.has(m.info.id)) {
      seenIds.add(m.info.id)
      unique.push(m)
    }
  }
  const filteredMessages = unique.filter(messageHasContent)
  const result: VisibleMessageEntry[] = []

  for (let i = 0; i < filteredMessages.length; i++) {
    const msg = filteredMessages[i]
    if (!endsWithTool(msg)) {
      result.push({ message: msg, sourceIds: [msg.info.id] })
      continue
    }

    const sourceIds = [msg.info.id]
    let j = i + 1

    while (j < filteredMessages.length) {
      if (isToolOnlyFollowUp(filteredMessages[j])) {
        sourceIds.push(filteredMessages[j].info.id)
        j++
      } else if (isMergeableTrailing(filteredMessages[j])) {
        sourceIds.push(filteredMessages[j].info.id)
        j++
        // 如果该消息也以 tool 结尾（text 在 tool 前面，是中间说明不是结论），
        // 继续合并链；只有 text 在 tool 后面（真正收尾）才终止
        if (!endsWithTool(filteredMessages[j - 1])) break
      } else {
        break
      }
    }

    if (j === i + 1) {
      result.push({ message: msg, sourceIds })
    } else {
      const mergedMessages = filteredMessages.slice(i + 1, j)
      const tailContent = mergedMessages.flatMap(message => message.content)
      // 合并后如果任何源消息在 streaming，合并结果也应该是 streaming
      const anyStreaming = msg.isStreaming || mergedMessages.some(m => m.isStreaming)
      result.push({
        message: { ...msg, content: [...msg.content, ...tailContent], isStreaming: anyStreaming },
        sourceIds,
      })
      i = j - 1
    }
  }

  return result
}
