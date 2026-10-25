// ============================================
// SubagentDialog — 子代理详情
// ============================================
//
// 面板上的一行只够放标题和状态。要回答「这个子代理到底做了什么」，
// 需要看它的会话内容：最后一条回复（结论）、轮次与步数、起止时间。
//
// 数据来源是子会话自己的消息流（`GET /api/session/{childId}/message`），
// 而不是父会话里的 task/subagent 工具输出 —— 后者只有一行回执
// （「The subagent is working in the background (sessionID: ...)」），
// 真正的工作内容全在子会话里。
//
// 刻意只拉最后一小段：子代理动辄几十轮，完整历史没有意义，
// 用户要看的是「它得出了什么结论」。

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { formatDetailedDateTime, formatDuration } from '../../utils/formatUtils'
import { cn } from '../../utils/cn'
import { getSessionMessages } from '../../api/message'
import type { ApiMessageWithParts } from '../../api/types'
import type { ChildSessionInfo } from '../../store/childSessionStore'

/** 只取尾部若干条：够拼出最后一轮的用户提问 + 子代理结论 */
const TAIL_MESSAGE_LIMIT = 30

interface SubagentDialogProps {
  child: ChildSessionInfo | null
  directory?: string
  serverId?: string
  onClose: () => void
  /** 跳到对话里对应的那条 task/subagent 工具调用 */
  onScrollToMessage?: (messageId: string) => void
  /** 直接打开子会话（在分屏或主区域查看完整过程） */
  onOpenSession?: (sessionId: string) => void
}

/** 一行「标签 + 值」，值与标签对齐，长值换行而不是溢出 */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[length:var(--fs-xs)]">
      <span className="w-16 shrink-0 text-text-500">{label}</span>
      <span className="min-w-0 flex-1 break-words text-text-200">{children}</span>
    </div>
  )
}

/** 从消息里提取可读文本：正文优先，没有正文时退回首条用户提问 */
function extractTailText(messages: ApiMessageWithParts[]): { prompt: string; reply: string } {
  let prompt = ''
  let reply = ''

  for (const message of messages) {
    const role = (message.info as { role?: string }).role
    if (role === 'user') {
      const text = (message.info as { text?: string }).text ?? ''
      const fromParts = message.parts
        .filter(part => (part as { type?: string }).type === 'text')
        .map(part => (part as { text?: string }).text ?? '')
        .join('')
      // 用最后一条用户提问：子代理中途可能被追加指令
      prompt = (text || fromParts).trim() || prompt
      continue
    }
    if (role !== 'assistant') continue
    const text = message.parts
      .filter(part => (part as { type?: string }).type === 'text')
      .map(part => (part as { text?: string }).text ?? '')
      .join('')
      .trim()
    // 用最后一段非空正文作为结论
    if (text) reply = text
  }

  return { prompt, reply }
}

/** 统计轮次与步数（user 消息数 / assistant 消息数） */
function countTurns(messages: ApiMessageWithParts[]): { turns: number; steps: number } {
  let turns = 0
  let steps = 0
  for (const message of messages) {
    const role = (message.info as { role?: string }).role
    if (role === 'user') turns += 1
    else if (role === 'assistant') steps += 1
  }
  return { turns, steps }
}

export const SubagentDialog = memo(function SubagentDialog({
  child,
  directory,
  serverId,
  onClose,
  onScrollToMessage,
  onOpenSession,
}: SubagentDialogProps) {
  const { t } = useTranslation(['chat', 'common'])
  /**
   * 加载结果按「为哪个子代理加载」记录。
   *
   * 不用独立的 loading 布尔：渲染期重置 + effect 里异步清除，两者会在
   * 同一帧竞争（React 会把渲染期的 setState 与随后的异步 setState 合并），
   * 实测表现为弹窗一直停在「加载中」。
   *
   * 改成记录 `{ for, messages, failed }`：`for !== childId` 就是「还没加载完」，
   * 状态只有一个来源，不存在竞态。
   */
  const [loaded, setLoaded] = useState<{
    for: string | null
    messages: ApiMessageWithParts[]
    failed: boolean
  }>({ for: null, messages: [], failed: false })
  /** 请求序号：快速切换子代理时丢弃上一个的迟到响应 */
  const requestIdRef = useRef(0)

  const childId = child?.id ?? null
  const loading = childId !== null && loaded.for !== childId
  const messages = loading ? [] : loaded.messages
  const failed = !loading && loaded.failed

  useEffect(() => {
    if (!childId) return
    const requestId = ++requestIdRef.current
    void (async () => {
      try {
        const page = await getSessionMessages(childId, TAIL_MESSAGE_LIMIT, directory, serverId, {
          // project:false —— 这里要的是子代理真实说了什么，
          // 不能用会剥掉正文的轻量投影
          project: false,
        })
        if (requestId !== requestIdRef.current) return
        setLoaded({ for: childId, messages: page, failed: false })
      } catch {
        if (requestId !== requestIdRef.current) return
        setLoaded({ for: childId, messages: [], failed: true })
      }
    })()
  }, [childId, directory, serverId])
  /**
   * 注意依赖里**不放 `t`**：i18next 的 `t` 在语言切换时会换引用，
   * 放进依赖会让弹窗开着时切语言就重新拉一遍消息。错误文案在渲染时翻译。
   */

  const { prompt, reply } = extractTailText(messages)
  const { turns, steps } = countTurns(messages)

  const [openedAt] = useState(() => Date.now())
  const duration =
    child && child.createdAt > 0 && child.status !== 'running' && openedAt > child.createdAt
      ? openedAt - child.createdAt
      : null

  const handleJump = useCallback(() => {
    if (!child) return
    onScrollToMessage?.(child.id)
    onClose()
  }, [child, onScrollToMessage, onClose])

  const handleOpenSession = useCallback(() => {
    if (!child) return
    onOpenSession?.(child.id)
    onClose()
  }, [child, onOpenSession, onClose])

  const statusLabel = child
    ? child.status === 'running'
      ? t('chat:workStatus.subagent.working')
      : child.status === 'error'
        ? t('chat:workStatus.subagent.failed')
        : t('chat:workStatus.subagent.done')
    : ''

  return (
    <Dialog
      isOpen={child !== null}
      onClose={onClose}
      title={t('chat:workStatus.subagent.dialogTitle')}
      width={640}
    >
      {child ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <DetailRow label={t('chat:workStatus.subagent.detailStatus')}>
              <span
                className={cn(
                  child.status === 'running' && 'text-info-100',
                  child.status === 'error' && 'text-danger-100',
                )}
              >
                {statusLabel}
              </span>
            </DetailRow>
            {child.agent ? (
              <DetailRow label={t('chat:workStatus.subagent.detailAgent')}>
                <span className="font-mono text-[length:var(--fs-xxs)]">{child.agent}</span>
              </DetailRow>
            ) : null}
            {child.createdAt > 0 ? (
              <DetailRow label={t('chat:workStatus.subagent.detailStarted')}>
                {formatDetailedDateTime(child.createdAt)}
              </DetailRow>
            ) : null}
            {duration !== null && duration >= 0 ? (
              <DetailRow label={t('chat:workStatus.subagent.detailDuration')}>
                {formatDuration(duration)}
              </DetailRow>
            ) : null}
            {!loading && !failed && messages.length > 0 ? (
              <DetailRow label={t('chat:workStatus.subagent.detailScale')}>
                {t('chat:workStatus.subagent.detailScaleValue', { turns, steps })}
              </DetailRow>
            ) : null}
            <DetailRow label={t('chat:workStatus.subagent.detailId')}>
              <span className="font-mono text-[length:var(--fs-xxs)]">{child.id}</span>
            </DetailRow>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[length:var(--fs-xs)] text-text-400">
              <Spinner size="xs" tone="current" variant="ring" />
              {t('common:loading')}
            </div>
          ) : failed ? (
            <p className="py-4 text-[length:var(--fs-xs)] text-text-400">
              {t('chat:workStatus.subagent.detailLoadFailed')}
            </p>
          ) : (
            <>
              {prompt ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[length:var(--fs-xxs)] text-text-500">
                    {t('chat:workStatus.subagent.detailPrompt')}
                  </span>
                  <div className="max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words rounded-md border border-border-200/50 bg-bg-200/40 px-3 py-2 text-[length:var(--fs-xs)] text-text-200">
                    {prompt}
                  </div>
                </div>
              ) : null}

              {reply ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[length:var(--fs-xxs)] text-text-500">
                    {t('chat:workStatus.subagent.detailReply')}
                  </span>
                  <div className="max-h-64 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words rounded-md border border-border-200/50 bg-bg-100 px-3 py-2 text-[length:var(--fs-xs)] text-text-200">
                    {reply}
                  </div>
                </div>
              ) : (
                <p className="py-2 text-[length:var(--fs-xs)] text-text-400">
                  {t('chat:workStatus.subagent.detailNoReply')}
                </p>
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {onScrollToMessage ? (
              <Button variant="ghost" size="sm" onClick={handleJump}>
                {t('chat:workStatus.subagent.jumpToMessage')}
              </Button>
            ) : null}
            {onOpenSession ? (
              <Button variant="secondary" size="sm" onClick={handleOpenSession}>
                {t('chat:workStatus.subagent.openSession')}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common:close')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  )
})
