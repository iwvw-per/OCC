import type { Attachment } from '../features/attachment/types'
import type { ApiMessage, ApiMessageWithParts, ApiPart } from '../api/types'
import type { Content, Message, MessageInfo, ReasoningContent, TextContent, ToolContent, UserMessageInfo } from '../types/message'
import { isUserMessage } from '../types/message'

type ApiMessageEnvelope = ApiMessageWithParts | { message: ApiMessageWithParts['info']; parts: ApiMessageWithParts['parts'] }

function getEnvelopeInfo(apiMessage: ApiMessageEnvelope): ApiMessageWithParts['info'] {
  return 'info' in apiMessage ? apiMessage.info : apiMessage.message
}

/**
 * 把 v1 形状的单个 part 折叠为 v2 content。
 *
 * v1 有 12 种 part，v2 content 只有 text / reasoning / tool 三种。本函数：
 * - text / reasoning / tool：一对一折叠；
 * - file / agent：作为用户附件挂到 info.attachments（不进入 content）；
 * - step-start / step-finish / snapshot / patch / subtask / retry / compaction：v2 无对应
 *   概念，丢弃（这些基础设施 part 在 v1 后端渲染里也只是装饰，不影响对话正文）。
 */
export function foldPartToContent(apiPart: ApiPart): Content | null {
  switch (apiPart.type) {
    case 'text':
      return {
        id: apiPart.id,
        sessionID: apiPart.sessionID,
        messageID: apiPart.messageID,
        type: 'text',
        text: apiPart.text ?? '',
        synthetic: apiPart.synthetic,
        time: apiPart.time,
      } as TextContent
    case 'reasoning':
      return {
        id: apiPart.id,
        sessionID: apiPart.sessionID,
        messageID: apiPart.messageID,
        type: 'reasoning',
        text: apiPart.text ?? '',
        time: apiPart.time ?? { start: 0 },
      } as ReasoningContent
    case 'tool':
      return {
        id: apiPart.id,
        sessionID: apiPart.sessionID,
        messageID: apiPart.messageID,
        type: 'tool',
        callID: apiPart.callID ?? apiPart.id,
        tool: apiPart.tool ?? '',
        state: apiPart.state,
      } as ToolContent
    default:
      return null
  }
}

/** 把用户消息里的 file/agent part 折叠为 Attachment 元信息（不进入 content）。 */
function foldUserAttachment(apiPart: ApiPart): Attachment | null {
  if (apiPart.type === 'file') {
    const isFolder = apiPart.mime === 'application/x-directory'
    const sourcePath =
      apiPart.source && 'path' in apiPart.source
        ? apiPart.source.path
        : apiPart.source && 'uri' in apiPart.source
          ? apiPart.source.uri
          : undefined
    return {
      id: apiPart.id || crypto.randomUUID(),
      type: isFolder ? 'folder' : 'file',
      displayName: apiPart.filename || sourcePath || 'file',
      url: apiPart.url,
      mime: apiPart.mime,
      relativePath: sourcePath,
      textRange: apiPart.source?.text
        ? {
            value: apiPart.source.text.value,
            start: apiPart.source.text.start,
            end: apiPart.source.text.end,
          }
        : undefined,
    }
  }
  if (apiPart.type === 'agent') {
    return {
      id: apiPart.id || crypto.randomUUID(),
      type: 'agent',
      displayName: apiPart.name,
      agentName: apiPart.name,
      textRange: apiPart.source
        ? {
            value: apiPart.source.value,
            start: apiPart.source.start,
            end: apiPart.source.end,
          }
        : undefined,
    }
  }
  return null
}

/** 折叠整条消息的 parts[] 为 content[]，并把用户附件挂到 info.attachments。 */
export function foldPartsToContent(apiMessage: ApiMessageEnvelope): Content[] {
  const info = getEnvelopeInfo(apiMessage)
  const isUser = info.role === 'user'
  const content: Content[] = []
  for (const part of apiMessage.parts ?? []) {
    const folded = foldPartToContent(part)
    if (folded) content.push(folded)
    else if (isUser) {
      const attachment = foldUserAttachment(part)
      if (attachment) pushAttachment(info, attachment)
    }
  }
  return content
}

function pushAttachment(info: ApiMessageWithParts['info'], attachment: Attachment): void {
  const list = (info as UserMessageInfo).attachments ?? []
  list.push(attachment)
  ;(info as UserMessageInfo).attachments = list
}

export function toUIMessage(apiMessage: ApiMessageEnvelope): Message {
  const message: Message = {
    info: getEnvelopeInfo(apiMessage) as MessageInfo,
    content: foldPartsToContent(apiMessage),
    isStreaming: false,
  }
  // 轻量投影响应：主机 Agent 剥掉了 reasoning 与工具大输出，只留对话与元数据壳，
  // 并附上 lightweight 统计。标记为压缩态，展开折叠块时再回拉完整 content。
  const lightweight = (
    apiMessage as {
      lightweight?: {
        reasoningCount?: number
        stepCount?: number
        durationMs?: number
        changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>
      }
    }
  ).lightweight
  if (lightweight) {
    message.isCompressed = true
    message.compressedStats = {
      reasoningCount: lightweight.reasoningCount ?? 0,
      stepCount: lightweight.stepCount ?? 0,
      ...(lightweight.durationMs != null ? { durationMs: lightweight.durationMs } : {}),
    }
    if (lightweight.changedFiles && lightweight.changedFiles.length > 0) {
      message.skeletonChangedFiles = lightweight.changedFiles
    }
  }
  return message
}

export function toUIMessageInfo(apiMessage: ApiMessage): MessageInfo {
  return apiMessage as MessageInfo
}

export function toUIPart(apiPart: ApiPart): Content | null {
  return foldPartToContent(apiPart)
}

/**
 * UI 消息 → API 信封（用于把本地消息合并回服务端快照）。
 *
 * ⚠️ 必须带上 `lightweight`，否则骨架轮会「越刷新越空」。
 *
 * 骨架轮的可见性完全依赖压缩统计（`chatAreaVisibility` 的
 * `hasSkeletonProcessStats`）：正文已被主机 Agent 剥掉，`content` 常常为空，
 * 只有 `stats.stepCount / reasoningCount` 能让它挂上一个「已处理 N 步」的折叠壳。
 *
 * 而 `toUIMessage` 是**从 `lightweight` 反推出** `compressedStats` 的。先前这里
 * 只搬了 `info` + `parts`，`lightweight` 在往返中丢失 —— 消息一旦经过
 * `mergeWithLocalStreamingMessages` 的 localOnly 分支（切后台再回前台、
 * 重连后 force 重载都会走到），折叠壳就消失，整轮 assistant 变成不可见，
 * 界面上只剩用户消息（实测移动端切后台再切回就是这个现象）。
 */
export function toApiMessageWithParts(message: Pick<Message, 'info' | 'content'>): ApiMessageWithParts {
  const envelope: ApiMessageWithParts & { lightweight?: unknown } = {
    info: message.info as ApiMessageWithParts['info'],
    parts: message.content as unknown as ApiMessageWithParts['parts'],
  }
  // 从 UI 侧的压缩统计还原 lightweight，保证往返不丢
  const stats = (message as { compressedStats?: Message['compressedStats'] }).compressedStats
  if (stats) {
    envelope.lightweight = {
      reasoningCount: stats.reasoningCount,
      stepCount: stats.stepCount,
      ...(stats.durationMs != null ? { durationMs: stats.durationMs } : {}),
      ...(() => {
        const changedFiles = (message as { skeletonChangedFiles?: Message['skeletonChangedFiles'] })
          .skeletonChangedFiles
        return changedFiles && changedFiles.length > 0 ? { changedFiles } : {}
      })(),
    }
  }
  return envelope
}

export function isUserUIMessage(message: Message): message is Message & { info: UserMessageInfo } {
  return isUserMessage(message.info)
}
