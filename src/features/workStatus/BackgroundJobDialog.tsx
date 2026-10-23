// ============================================
// BackgroundJobDialog — 后台任务详情
// ============================================
//
// 面板上的一行只够放命令和状态；要看「它到底在跑什么、输出了什么」，
// 需要能读到完整命令、工作目录、起止时间、退出码，以及输出。
//
// 输出走 `shell.output` 分页接口（`cursor` / `limit`）。停止的 shell 输出
// 落在服务端的文件里，仍在跑的也能增量读到当前进度，因此运行中的任务
// 同样可以打开这个弹窗查看实时输出。

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { formatDetailedDateTime, formatDuration } from '../../utils/formatUtils'
import { cn } from '../../utils/cn'
import { tryGetShellOutput } from '../../api/shell'
import type { BackgroundJob } from './backgroundJobs'

/** 一次拉取的输出字节上限：够看一屏多，又不至于把弹窗拖慢 */
const OUTPUT_PAGE_LIMIT = 16_000

interface BackgroundJobDialogProps {
  job: BackgroundJob | null
  directory?: string
  serverId?: string
  onClose: () => void
  /** 跳到对话里发起这条任务的位置 */
  onScrollToMessage?: (messageId: string) => void
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

export const BackgroundJobDialog = memo(function BackgroundJobDialog({
  job,
  directory,
  serverId,
  onClose,
  onScrollToMessage,
}: BackgroundJobDialogProps) {
  const { t } = useTranslation(['chat', 'common'])
  const [output, setOutput] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 请求序号：快速切换任务时丢弃上一个任务的迟到响应 */
  const requestIdRef = useRef(0)

  const jobId = job?.id ?? null
  /**
   * 输出加载状态挂在 key 上而不是靠 effect 清空。
   *
   * 用 `useState` 记录「当前是为哪个任务初始化的」：任务变化时在渲染期直接
   * 重置（React 允许的 derived-state 模式），避免在 effect 里同步 setState
   * 触发的级联渲染。
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  if (loadedFor !== jobId) {
    setLoadedFor(jobId)
    setOutput('')
    setError(null)
    setLoading(jobId !== null)
  }

  useEffect(() => {
    if (!jobId) return
    const requestId = ++requestIdRef.current
    void (async () => {
      const chunk = await tryGetShellOutput(jobId, {
        directory,
        serverId,
        limit: OUTPUT_PAGE_LIMIT,
      })
      if (requestId !== requestIdRef.current) return
      if (!chunk) {
        // 子代理任务或已被清理的 shell 没有输出文件；这不是错误
        setError(t('chat:workStatus.backgroundJob.outputUnavailable'))
      } else {
        setOutput(chunk.output)
        if (chunk.truncated) {
          setError(t('chat:workStatus.backgroundJob.outputTruncated'))
        }
      }
      setLoading(false)
    })()
  }, [jobId, directory, serverId, t])

  const handleJump = useCallback(() => {
    if (!job?.messageId) return
    onScrollToMessage?.(job.messageId)
    onClose()
  }, [job, onScrollToMessage, onClose])

  /**
   * 耗时。
   *
   * 运行中的任务用「打开弹窗那一刻」的时间做终点，而不是每次渲染读 Date.now()：
   * 渲染必须是纯函数，读时钟会让同一份输入产出不同输出。
   *
   * ⚠️ 结束时间只认 `finishedAt`：历史推导的 `startedAt` 用的是消息创建时间，
   * 与 `finishedAt` 同源，两者相等会让耗时永远显示 0ms。没有真实结束时间时
   * 宁可不显示，也不给一个假读数。
   */
  const [openedAt] = useState(() => Date.now())
  const duration =
    job && job.startedAt > 0
      ? job.finishedAt != null && job.finishedAt > job.startedAt
        ? job.finishedAt - job.startedAt
        : job.status === 'running' && openedAt > job.startedAt
          ? openedAt - job.startedAt
          : null
      : null

  const statusLabel = job
    ? job.status === 'running'
      ? t('chat:workStatus.backgroundJob.running')
      : job.status === 'error'
        ? t('chat:workStatus.backgroundJob.failed')
        : job.status === 'cancelled'
          ? t('chat:workStatus.backgroundJob.cancelled')
          : job.status === 'completed'
            ? t('chat:workStatus.backgroundJob.done')
            : t('chat:workStatus.backgroundJob.unknown')
    : ''

  return (
    <Dialog
      isOpen={job !== null}
      onClose={onClose}
      title={t('chat:workStatus.backgroundJob.dialogTitle')}
      width={640}
    >
      {job ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <DetailRow label={t('chat:workStatus.backgroundJob.detailKind')}>
              {job.kind === 'shell'
                ? t('chat:workStatus.backgroundJob.kindShell')
                : t('chat:workStatus.backgroundJob.kindSubagent')}
            </DetailRow>
            <DetailRow label={t('chat:workStatus.backgroundJob.detailStatus')}>
              <span
                className={cn(
                  job.status === 'running' && 'text-info-100',
                  job.status === 'error' && 'text-danger-100',
                )}
              >
                {statusLabel}
              </span>
              {job.exit != null ? (
                <span className="ml-2 text-text-500">
                  {t('chat:workStatus.backgroundJob.detailExit', { code: job.exit })}
                </span>
              ) : null}
            </DetailRow>
            {job.startedAt > 0 ? (
              <DetailRow label={t('chat:workStatus.backgroundJob.detailStarted')}>
                {formatDetailedDateTime(job.startedAt)}
              </DetailRow>
            ) : null}
            {duration !== null && duration >= 0 ? (
              <DetailRow label={t('chat:workStatus.backgroundJob.detailDuration')}>
                {formatDuration(duration)}
              </DetailRow>
            ) : null}
            <DetailRow label={t('chat:workStatus.backgroundJob.detailId')}>
              <span className="font-mono text-[length:var(--fs-xxs)]">{job.id}</span>
            </DetailRow>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--fs-xs)] text-text-500">
              {t('chat:workStatus.backgroundJob.detailCommand')}
            </span>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-200/60 p-2 font-mono text-[length:var(--fs-xxs)] text-text-200 custom-scrollbar">
              {job.title}
            </pre>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[length:var(--fs-xs)] text-text-500">
                {t('chat:workStatus.backgroundJob.detailOutput')}
              </span>
              {loading ? <Spinner size="xs" tone="muted" /> : null}
            </div>
            <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-200/60 p-2 font-mono text-[length:var(--fs-xxs)] text-text-200 custom-scrollbar">
              {output || (loading ? '' : t('chat:workStatus.backgroundJob.noOutput'))}
            </pre>
            {error ? (
              <span className="text-[length:var(--fs-xxs)] text-text-500">{error}</span>
            ) : null}
          </div>

          {job.messageId && onScrollToMessage ? (
            <div className="flex justify-end border-t border-border-200/50 pt-2">
              <Button variant="ghost" size="sm" onClick={handleJump}>
                {t('chat:workStatus.backgroundJob.jumpToMessage')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
})
