// ============================================
// WorkStatus sections — 各板块实现
// ============================================
//
// 每个板块在无内容时返回 null，面板因此向顶部收拢，而不是为空气留位置。
//
// 数据全部复用既有 store / hook：不新增轮询，MCP 与 Skills 走一次性懒加载。

import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckIcon,
  CircleIcon,
  ClockIcon,
  DatabaseIcon,
  FolderIcon,
  GitBranchIcon,
  LayersIcon,
  PinIcon,
  PlugIcon,
  StatsIcon,
  TerminalIcon,
  UsersIcon,
} from '../../components/Icons'
import { Spinner } from '../../components/ui/Spinner'
import { Switch } from '../../components/ui/Switch'
import { getDirectoryName } from '../../utils/directoryUtils'
import { formatCost, formatDuration } from '../../utils/formatUtils'
import { useMessages } from '../../store/messageStoreHooks'
import { useTodos } from '../../store/todoStore'
import { useChildSessions, type ChildSessionInfo } from '../../store/childSessionStore'
import { pinnedMessagesStore, usePinnedMessages } from '../../store/pinnedMessagesStore'
import { useSessionStatsFor } from '../../hooks/useSessionStatsFor'
import { useSessionTurnStats } from '../../hooks/useSessionTurnStats'
import { useVcsInfo } from '../../hooks/useVcsInfo'
import { getMcpStatus, connectMcpServer, disconnectMcpServer } from '../../api/mcp'
import {
  WorkStatusCollapsibleSection,
  WorkStatusMeter,
  WorkStatusRow,
  WorkStatusRowAction,
  WorkStatusRows,
  WorkStatusSection,
  WorkStatusValue,
} from './WorkStatusPrimitives'
import { collectBackgroundJobs, type BackgroundJob } from './backgroundJobs'
import { BackgroundJobDialog } from './BackgroundJobDialog'
import { SubagentDialog } from './SubagentDialog'
import { useSessionNavigation } from '../../contexts/SessionNavigationContext'
import { backgroundJobStore, useLiveBackgroundJobs } from '../../store/backgroundJobStore'
import { useReconcileRunningShells } from '../../hooks/useReconcileRunningShells'
import type { MCPStatus } from '../../types/api/mcp'

export interface WorkStatusSectionContext {
  sessionId: string | null
  directory?: string
  serverId?: string
  contextLimit: number
  onScrollToMessage: (messageId: string) => void
}

// ─── 会话：上下文占用 + 成本 ──────────────────

export const WorkStatusSessionSection = memo(function WorkStatusSessionSection({
  sessionId,
  contextLimit,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  /**
   * 不兜底默认窗口：实测某模型真实窗口 1000000，旧的 200000 兜底会让
   * 百分比虚高 5 倍。窗口未知时 `contextPercent` 为 null，这里显示「—」。
   */
  const stats = useSessionStatsFor(sessionId, contextLimit > 0 ? contextLimit : 0)
  // contextUsed 为 null 表示服务端还没给出实测值 —— 显示「—」，不做字符估算
  const hasUsage = stats.contextUsed != null && stats.contextUsed > 0
  const percent = hasUsage ? stats.contextPercent : null
  const cost = stats.totalCost > 0 ? stats.totalCost : null

  const rounded = percent === null ? null : Math.round(percent)
  const meterColor =
    rounded === null
      ? 'hsl(var(--success-100))'
      : rounded >= 90
        ? 'hsl(var(--danger-100))'
        : rounded >= 70
          ? 'hsl(var(--warning-100))'
          : 'hsl(var(--success-100))'

  // 标题常驻：新会话 / 空白窗口还没有 token 用量，但「会话」这一段仍要可辨识，
  // 否则刚开面板会像缺了一块。用量行与进度条则只在有数据时出现。
  return (
    <WorkStatusSection title={t('workStatus.section.session')}>
      {hasUsage ? (
        <>
          <WorkStatusRow
            icon={<DatabaseIcon size={14} />}
            label={t('workStatus.context.label')}
            value={
              <>
                <WorkStatusValue>{percent === null ? '\u2014' : `${Math.min(percent, 999).toFixed(1)}%`}</WorkStatusValue>
                {cost !== null ? <WorkStatusValue tone="muted">{formatCost(cost)}</WorkStatusValue> : null}
              </>
            }
          />
          <WorkStatusMeter percent={percent ?? 0} color={meterColor} />
        </>
      ) : (
        <WorkStatusRow label={t('workStatus.context.label')} value={<WorkStatusValue tone="muted">—</WorkStatusValue>} />
      )}
    </WorkStatusSection>
  )
})

// ─── 项目：名称 + 分支 ────────────────────────

export const WorkStatusProjectSection = memo(function WorkStatusProjectSection({
  directory,
  serverId,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const { vcsInfo, isLoading } = useVcsInfo(directory, serverId)
  const projectLabel = directory ? getDirectoryName(directory) : null
  const branch = vcsInfo?.branch?.trim() || null
  // 非 git 仓库时 vcsInfo 已返回（branch 为 null），此时不再是「加载中」。
  // 只有首次、尚无任何结果时才显示转圈，避免轮询期间一直闪。
  const showLoading = isLoading && vcsInfo === null

  if (!projectLabel && !branch && !showLoading) return null

  return (
    <WorkStatusSection
      title={t('workStatus.section.project')}
      icon={<FolderIcon size={14} />}
      summary={projectLabel}
    >
      {branch || showLoading ? (
        <WorkStatusRow
          icon={<GitBranchIcon size={14} />}
          label={
            branch ? (
              <span className="font-mono">{branch}</span>
            ) : (
              <Spinner size="xs" tone="muted" />
            )
          }
        />
      ) : null}
    </WorkStatusSection>
  )
})

// ─── 轮次统计 ─────────────────────────────────

export const WorkStatusTurnStatsSection = memo(function WorkStatusTurnStatsSection({
  sessionId,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const stats = useSessionTurnStats(sessionId)
  if (stats.turns === 0 && stats.steps === 0) return null

  return (
    <WorkStatusCollapsibleSection
      title={t('workStatus.section.turnStats')}
      icon={<StatsIcon size={14} />}
      id="turnStats"
      summary={t('workStatus.turnStats.summary', { turns: stats.turns, steps: stats.steps })}
    >
      <WorkStatusRows>
        <WorkStatusRow
          label={t('workStatus.turnStats.modelTime')}
          value={stats.modelMs > 0 ? formatDuration(stats.modelMs) : '—'}
        />
        <WorkStatusRow
          label={t('workStatus.turnStats.toolTime')}
          value={stats.toolMs > 0 ? formatDuration(stats.toolMs) : '—'}
        />
        <WorkStatusRow
          label={t('workStatus.turnStats.ttft')}
          value={stats.ttftMs !== null ? formatDuration(stats.ttftMs) : '—'}
        />
        <WorkStatusRow
          label={t('workStatus.turnStats.tps')}
          value={stats.tokensPerSec !== null ? `${stats.tokensPerSec.toFixed(1)} tok/s` : '—'}
        />
        <WorkStatusRow
          label={t('workStatus.turnStats.cacheHit')}
          value={stats.cacheHitPercent !== null ? `${Math.round(stats.cacheHitPercent)}%` : '—'}
        />
      </WorkStatusRows>
    </WorkStatusCollapsibleSection>
  )
})

// ─── 子代理 ───────────────────────────────────

export const WorkStatusSubagentsSection = memo(function WorkStatusSubagentsSection({
  sessionId,
  directory,
  serverId,
  onScrollToMessage,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const children = useChildSessions(sessionId)
  /** 正在查看详情的子代理；null = 弹窗关闭 */
  const [detailChild, setDetailChild] = useState<ChildSessionInfo | null>(null)
  const { navigateToSession, openSessionInSplit } = useSessionNavigation()

  // 已完成（idle）折叠成一组：跑完的子代理会不断堆积，平铺会把进行中的挤下去。
  // error 留在进行中组：失败是需要被看见的，不藏进收起的组里。
  const { active, completed } = useMemo(() => {
    const active: ChildSessionInfo[] = []
    const completed: ChildSessionInfo[] = []
    for (const child of children) {
      if (child.status === 'idle') completed.push(child)
      else active.push(child)
    }
    return { active, completed }
  }, [children])

  /**
   * 打开子会话。
   *
   * 必须在早退之前声明：`children.length === 0` 时组件返回 null，
   * 若把 hook 放在早退之后，有子代理和没有子代理的两次渲染 hook 数量不同，
   * React 会直接抛错（rules-of-hooks）。
   */
  const handleOpenSession = useCallback(
    (childId: string) => {
      // 优先分屏（保留当前会话在视野里）；分屏不可用时退回主区域跳转
      if (!openSessionInSplit?.(childId, directory)) navigateToSession(childId, directory)
    },
    [directory, navigateToSession, openSessionInSplit],
  )

  if (children.length === 0) return null

  const runningCount = active.filter(child => child.status === 'running').length

  /**
   * 弹窗里的子代理跟随最新状态刷新，而不是保留打开那一刻的快照 ——
   * 打开时还在跑的子代理会结束，状态要跟着变。
   */
  const activeDetail = detailChild
    ? children.find(child => child.id === detailChild.id) ?? detailChild
    : null

  const renderRow = (child: ChildSessionInfo) => (
    <WorkStatusRow
      key={child.id}
      onClick={() => setDetailChild(child)}
      ariaLabel={t('workStatus.subagent.openDetail', { title: child.title })}
      label={
        <span className="min-w-0 truncate text-left" title={child.title}>
          {child.title}
        </span>
      }
      value={
        child.status === 'running' ? (
          <WorkStatusValue tone="info">
            <span className="inline-flex items-center gap-1.5">
              <Spinner size="xs" tone="current" variant="ring" />
              {t('workStatus.subagent.working')}
            </span>
          </WorkStatusValue>
        ) : child.status === 'error' ? (
          <WorkStatusValue tone="error">{t('workStatus.subagent.failed')}</WorkStatusValue>
        ) : (
          <WorkStatusValue tone="muted">{t('workStatus.subagent.done')}</WorkStatusValue>
        )
      }
    />
  )

  return (
    <>
      <WorkStatusCollapsibleSection
        title={t('workStatus.section.subagents')}
        icon={<UsersIcon size={14} />}
        id="subagents"
        summary={runningCount > 0 ? `${runningCount}/${children.length}` : String(children.length)}
      >
        <WorkStatusRows className="max-h-56 overflow-y-auto">
          {active.map(renderRow)}
          {completed.length > 0 ? (
            // 默认收起（workStatusStore 对未登记的 id 缺省为 false），展开态照常持久化
            <WorkStatusCollapsibleSection
              id="subagents-completed"
              title={t('workStatus.subagent.completedGroup')}
              summary={String(completed.length)}
            >
              <WorkStatusRows>{completed.map(renderRow)}</WorkStatusRows>
            </WorkStatusCollapsibleSection>
          ) : null}
        </WorkStatusRows>
      </WorkStatusCollapsibleSection>

      <SubagentDialog
        child={activeDetail}
        directory={directory}
        serverId={serverId}
        onClose={() => setDetailChild(null)}
        onScrollToMessage={onScrollToMessage}
        onOpenSession={handleOpenSession}
      />
    </>
  )
})

// ─── 后台任务 ─────────────────────────────────

/**
 * 后台任务（shell / subagent）。
 *
 * v2 没有查询后台任务的 HTTP 端点，只能从消息流推导（见 backgroundJobs.ts）。
 * 这里刻意**不**直接用 `useMessages`：流式时 messages 每帧换新数组，而
 * `collectBackgroundJobs` 要遍历全部消息，长会话里会变成每帧 O(7000)。
 * 改为先按「消息条数 + 最后一条消息 id」做粗筛，只在条数变化或出现完成通知时重算。
 */
export const WorkStatusBackgroundJobsSection = memo(function WorkStatusBackgroundJobsSection({
  sessionId,
  directory,
  serverId,
  onScrollToMessage,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const messages = useMessages(sessionId)
  const live = useLiveBackgroundJobs(sessionId)
  /** 正在查看详情的任务；null = 弹窗关闭 */
  const [detailJob, setDetailJob] = useState<BackgroundJob | null>(null)
  /**
   * 只在「任务集合可能变了」时重算。
   *
   * 流式时 messages 每帧换新数组，而 `collectBackgroundJobs` 要遍历全部消息
   * （长会话实测 7000 条）。用 `{条数, 最后一条 id, 实时表大小}` 作为缓存键：
   * 条数不变就说明没有新的工具调用、也没有新的完成通知。
   *
   * ⚠️ 实时表的大小不够：同一个任务从 running 变 completed 时大小不变，
   * 状态却变了。把「状态序列」也压进键里，状态变化才不会被缓存吞掉。
   */
  const liveSignature = useMemo(() => {
    if (live.size === 0) return ''
    const parts: string[] = []
    for (const [id, job] of live) parts.push(`${id}:${job.status}`)
    return parts.join(',')
  }, [live])
  /**
   * 用户已清除的任务 id。
   *
   * 用 useSyncExternalStore 订阅 store：清除后必须立刻重算 jobs，
   * 否则面板要等下一次消息变化才更新（点了「清除」没反应）。
   */
  const dismissed = useSyncExternalStore(
    backgroundJobStore.subscribe,
    () => backgroundJobStore.getDismissed(sessionId ?? ''),
    () => backgroundJobStore.getDismissed(sessionId ?? ''),
  )
  const dismissedKey = useMemo(() => [...dismissed].sort().join(','), [dismissed])
  const jobsKey = `${messages.length}:${messages[messages.length - 1]?.info.id ?? ''}:${liveSignature}:${dismissedKey}`
  const jobs = useMemo(
    () => collectBackgroundJobs(messages, live, dismissed),
    // 只用粗筛键：messages 引用每帧都变，放进依赖等于每帧重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobsKey],
  )

  /**
   * 消息流能证明是后台任务的 id。
   *
   * 校正时必须用它做白名单：`shell.list` 分不出前后台，直接拿来建条目会把
   * 正在执行的前台命令也列进面板（实测 `sleep 12; ...` 会占满面板）。
   */
  const derivedJobIds = useMemo(() => new Set(jobs.map(job => job.id)), [jobs])
  useReconcileRunningShells(sessionId, directory, serverId, derivedJobIds)

  /**
   * 弹窗里的任务跟随 jobs 的最新状态刷新，而不是保留打开那一刻的快照 ——
   * 运行中的任务在弹窗开着时会结束，状态与输出都要跟着变。
   */
  const activeDetail = detailJob ? jobs.find(job => job.id === detailJob.id) ?? detailJob : null

  const closeDetail = useCallback(() => setDetailJob(null), [])

  const handleRowClick = useCallback((job: BackgroundJob) => {
    setDetailJob(job)
  }, [])

  const running = jobs.filter(job => job.status === 'running')
  const settled = jobs.filter(job => job.status !== 'running')

  if (jobs.length === 0) return null

  const renderRow = (job: BackgroundJob) => (
    <WorkStatusRow
      key={job.id}
      onClick={() => handleRowClick(job)}
      ariaLabel={t('workStatus.backgroundJob.openDetail', { title: job.title })}
      label={
        <span className="min-w-0 truncate text-left" title={job.title}>
          {job.title}
        </span>
      }
      value={
        job.status === 'running' ? (
          <WorkStatusValue tone="info">
            <span className="inline-flex items-center gap-1.5">
              <Spinner size="xs" tone="current" variant="ring" />
              {t('workStatus.backgroundJob.running')}
            </span>
          </WorkStatusValue>
        ) : job.status === 'error' ? (
          <WorkStatusValue tone="error">{t('workStatus.backgroundJob.failed')}</WorkStatusValue>
        ) : job.status === 'cancelled' ? (
          <WorkStatusValue tone="muted">{t('workStatus.backgroundJob.cancelled')}</WorkStatusValue>
        ) : job.status === 'completed' ? (
          <WorkStatusValue tone="muted">{t('workStatus.backgroundJob.done')}</WorkStatusValue>
        ) : (
          <WorkStatusValue tone="muted">{t('workStatus.backgroundJob.unknown')}</WorkStatusValue>
        )
      }
    />
  )

  return (
    <>
      <WorkStatusCollapsibleSection
        title={t('workStatus.section.backgroundJobs')}
        icon={<TerminalIcon size={14} />}
        id="backgroundJobs"
        summary={running.length > 0 ? `${running.length}/${jobs.length}` : String(jobs.length)}
        actionPlacement="beforeSummary"
        action={
          settled.length > 0 ? (
            <WorkStatusRowAction
              tone="default"
              onClick={() => backgroundJobStore.clearSettled(sessionId ?? '', settled.map(job => job.id))}
              ariaLabel={t('workStatus.backgroundJob.clearSettled')}
            >
              {t('workStatus.backgroundJob.clearSettledShort')}
            </WorkStatusRowAction>
          ) : undefined
        }
      >
        <WorkStatusRows className="max-h-56 overflow-y-auto">
          {running.length > 0 ? (
            <WorkStatusCollapsibleSection
              id="backgroundJobs-running"
              title={t('workStatus.backgroundJob.runningGroup')}
              summary={String(running.length)}
            >
              <WorkStatusRows>{running.map(renderRow)}</WorkStatusRows>
            </WorkStatusCollapsibleSection>
          ) : null}
          {settled.length > 0 ? (
            <WorkStatusCollapsibleSection
              id="backgroundJobs-settled"
              title={t('workStatus.backgroundJob.settledGroup')}
              summary={String(settled.length)}
            >
              <WorkStatusRows>{settled.map(renderRow)}</WorkStatusRows>
            </WorkStatusCollapsibleSection>
          ) : null}
        </WorkStatusRows>
      </WorkStatusCollapsibleSection>

      <BackgroundJobDialog
        job={activeDetail}
        directory={directory}
        serverId={serverId}
        onClose={closeDetail}
        onScrollToMessage={onScrollToMessage}
      />
    </>
  )
})

// ─── 任务 ─────────────────────────────────────

const STATUS_RANK: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 }

function TodoStatusIcon({ status }: { status: string }) {
  if (status === 'in_progress') return <CircleIcon size={13} className="text-info-100" />
  if (status === 'completed') return <CheckIcon size={13} className="text-success-100" />
  return <ClockIcon size={13} className="text-text-500" />
}

export const WorkStatusTasksSection = memo(function WorkStatusTasksSection({
  sessionId,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const todos = useTodos(sessionId)

  // 先做、再做待办、最后已完成：面板自上而下回答「现在在做什么」，
  // 已完成项永远不是答案。与输入框下拉不同，完成项保留——这是会话记录，不是待清队列。
  const visibleTodos = useMemo(
    () =>
      todos
        .map((todo, index) => ({ todo, index }))
        .filter(({ todo }) => todo.status !== 'cancelled')
        .sort((left, right) => {
          const rank = (STATUS_RANK[left.todo.status] ?? 1) - (STATUS_RANK[right.todo.status] ?? 1)
          return rank !== 0 ? rank : left.index - right.index
        })
        .map(({ todo }) => todo),
    [todos],
  )

  if (visibleTodos.length === 0) return null

  const doneCount = visibleTodos.filter(todo => todo.status === 'completed').length
  const activeTodo = visibleTodos.find(todo => todo.status === 'in_progress')

  const renderRow = (todo: (typeof visibleTodos)[number], key: string) => {
    const done = todo.status === 'completed'
    return (
      <WorkStatusRow
        key={key}
        leading={<TodoStatusIcon status={todo.status} />}
        muted={done}
        label={<span className={done ? 'line-through' : undefined}>{todo.content}</span>}
      />
    )
  }

  return (
    <WorkStatusCollapsibleSection
      title={t('workStatus.section.todos')}
      icon={<LayersIcon size={14} />}
      id="tasks"
      summary={`${doneCount}/${visibleTodos.length}`}
      collapsedContent={activeTodo ? <WorkStatusRows>{renderRow(activeTodo, 'collapsed-active')}</WorkStatusRows> : null}
    >
      <WorkStatusRows>
        {visibleTodos.map((todo, index) => renderRow(todo, `${todo.status}-${index}-${todo.content}`))}
      </WorkStatusRows>
    </WorkStatusCollapsibleSection>
  )
})

// ─── MCP ──────────────────────────────────────

export const WorkStatusMcpSection = memo(function WorkStatusMcpSection({
  sessionId,
  directory,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<Record<string, MCPStatus> | null>(null)
  const [busyServer, setBusyServer] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await getMcpStatus(directory))
    } catch {
      setStatus({})
    }
  }, [directory])

  useEffect(() => {
    /**
     * directory 首帧是空串、随后被会话元数据填上 —— 那会让这个 effect 跑两次，
     * 白白多发一轮 `/api/mcp` + `/api/debug/location`（实测首屏多 2 个往返）。
     *
     * 只有「已经打开会话但目录还没落定」时才等；真的没有会话（全局 scope）
     * 时 directory 一直是空串，必须照常加载，否则面板永远空白。
     */
    if (sessionId && !directory) return
    void load()
  }, [load, directory, sessionId])

  const servers = useMemo(
    () => Object.entries(status ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [status],
  )
  const connectedCount = servers.filter(([, entry]) => entry?.status === 'connected').length

  const handleToggle = useCallback(
    async (name: string, next: boolean) => {
      setBusyServer(name)
      try {
        if (next) await connectMcpServer(name, directory)
        else await disconnectMcpServer(name, directory)
        // 后端处理有延迟，稍等再拉一次状态
        await new Promise(resolve => setTimeout(resolve, 500))
        await load()
      } catch {
        // 失败时重读，让开关回到真实状态
        await load()
      } finally {
        setBusyServer(current => (current === name ? null : current))
      }
    },
    [directory, load],
  )

  if (servers.length === 0) return null

  return (
    <WorkStatusCollapsibleSection
      title={t('workStatus.section.mcp')}
      icon={<PlugIcon size={14} />}
      id="mcp"
      summary={`${connectedCount}/${servers.length}`}
    >
      <WorkStatusRows>
        {servers.map(([name, entry]) => {
          const connected = entry?.status === 'connected'
          const busy = busyServer === name
          const needsAuth = entry?.status === 'needs_auth' || entry?.status === 'needs_client_registration'
          const failed = entry?.status === 'failed'
          return (
            <WorkStatusRow
              key={name}
              leading={
                // scale 不改变布局盒，所以外层给一个等于缩放后宽度的定宽容器，
                // 同板块各行的名称才会左对齐（36 × 0.72 ≈ 26px）
                <span className="inline-flex w-[26px] shrink-0 items-center">
                  <Switch
                    checked={connected}
                    disabled={busy}
                    className="origin-left scale-[0.72]"
                    aria-label={t('workStatus.mcp.toggle', { name })}
                    onCheckedChange={checked => void handleToggle(name, checked)}
                  />
                </span>
              }
              label={name}
              muted={!connected}
              value={
                needsAuth ? (
                  <WorkStatusRowAction tone="warning" disabled={busy} onClick={() => void load()}>
                    {t('workStatus.mcp.needsAuth')}
                  </WorkStatusRowAction>
                ) : failed ? (
                  <WorkStatusRowAction tone="error" disabled={busy} onClick={() => void handleToggle(name, true)}>
                    {t('workStatus.mcp.failed')}
                  </WorkStatusRowAction>
                ) : undefined
              }
            />
          )
        })}
      </WorkStatusRows>
    </WorkStatusCollapsibleSection>
  )
})

// ─── 已固定的消息 ─────────────────────────────

export const WorkStatusPinnedSection = memo(function WorkStatusPinnedSection({
  sessionId,
  onScrollToMessage,
}: WorkStatusSectionContext) {
  const { t } = useTranslation('chat')
  const pinned = usePinnedMessages(sessionId)

  if (pinned.length === 0) return null

  return (
    <WorkStatusCollapsibleSection
      title={t('workStatus.section.pinnedMessages')}
      icon={<PinIcon size={14} />}
      id="pinnedMessages"
      summary={String(pinned.length)}
    >
      {pinned.map(entry => (
        <WorkStatusRow
          key={entry.messageId}
          leading={
            <button
              type="button"
              aria-label={t('workStatus.pinned.unpin')}
              onClick={event => {
                event.stopPropagation()
                if (sessionId) pinnedMessagesStore.unpin(sessionId, entry.messageId)
              }}
              className="shrink-0 rounded p-0.5 text-accent-main-100 transition-opacity hover:opacity-70"
            >
              <PinIcon size={13} />
            </button>
          }
          muted
          label={entry.excerpt || t('workStatus.pinned.unavailable')}
          onClick={() => onScrollToMessage(entry.messageId)}
          ariaLabel={t('workStatus.pinned.reveal')}
        />
      ))}
    </WorkStatusCollapsibleSection>
  )
})
