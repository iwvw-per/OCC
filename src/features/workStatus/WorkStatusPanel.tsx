// ============================================
// WorkStatusPanel — 对话列内的工作状态卡片
// ============================================
//
// 卡片是对话列的 flex 兄弟，不是浮层：它占自己的宽度，把对话挤窄，
// 而不是盖在内容上。
//
// 板块按用户保存的顺序渲染；每个板块无内容时返回 null，卡片因此向顶部
// 收拢，而不是为空气留位置。
//
// 卡片裁剪，滚动器在卡片内部：这样上下滚动阴影落在圆角边框内，
// 不会溢到外面。

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '../../components/ui/IconButton'
import { Button } from '../../components/ui/Button'
import { CogIcon } from '../../components/Icons'
import { cn } from '../../utils/cn'
import { workStatusStore, useWorkStatus } from '../../store/workStatusStore'
import {
  areAllWorkStatusSectionsHidden,
  isWorkStatusSectionVisible,
  sanitizeWorkStatusSectionOrder,
} from './sections'
import {
  WorkStatusBackgroundJobsSection,
  WorkStatusMcpSection,
  WorkStatusPinnedSection,
  WorkStatusProjectSection,
  WorkStatusSessionSection,
  WorkStatusSubagentsSection,
  WorkStatusTasksSection,
  WorkStatusTurnStatsSection,
} from './WorkStatusSections'
import { WorkStatusSectionsDialog } from './WorkStatusSectionsDialog'
import { useReconcileRunningShells } from '../../hooks/useReconcileRunningShells'

/**
 * 固定面板宽度。面板不可由用户拖拽调整：它是对话里的一个对象，
 * 不是停靠的窗格，所以没有 resizer，也不持久化宽度。
 */
export const WORK_STATUS_PANEL_WIDTH = 280

/** 对话列至少要给自己留的宽度。低于此值面板让位——被挤扁的对话比它挤掉的状态更贵 */
const WORK_STATUS_MIN_CHAT_WIDTH = 560

/** 卡片的左右外边距 */
const WORK_STATUS_PANEL_GUTTER = 8 + 16

/** 行宽低于此值时面板把空间还给对话 */
export const WORK_STATUS_REQUIRED_ROW_WIDTH =
  WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER + WORK_STATUS_MIN_CHAT_WIDTH

/**
 * 与上下文面板自身的宽度动画完全一致。
 *
 * 两者是对话列的兄弟节点，打开上下文面板会隐藏本面板。若本面板瞬时卸载，
 * 对话会先跳宽（本面板消失）再平滑变窄（上下文面板展开）——连续两次相反的
 * 宽度变化，看起来像抖动。用同一条曲线和时长收起，对话的宽度只朝一个方向动一次。
 */
const PANEL_TRANSITION_MS = 200
const PANEL_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

interface WorkStatusPanelProps {
  sessionId: string | null
  directory?: string
  serverId?: string
  contextLimit: number
  /** 面板当前是否应占位 */
  visible: boolean
  onScrollToMessage: (messageId: string) => void
}

export const WorkStatusPanel = memo(function WorkStatusPanel({
  sessionId,
  directory,
  serverId,
  contextLimit,
  visible,
  onScrollToMessage,
}: WorkStatusPanelProps) {
  const { t } = useTranslation(['chat', 'components'])
  const state = useWorkStatus()
  const [sectionsDialogOpen, setSectionsDialogOpen] = useState(false)
  // 乐观起步：板块在首次提交后才汇报自己，入场时先渲染「无内容」会让卡片闪一下再回来
  const [renderedSections, setRenderedSections] = useState(1)
  const frameRef = useRef<number | null>(null)

  const sectionOrder = useMemo(() => sanitizeWorkStatusSectionOrder(state.order), [state.order])
  /**
   * 用 `shell.list` 校正一次后台任务状态。
   *
   * 实时事件覆盖「页面开着」的情况；断线重连、后台标签页、先开页面后启动的
   * 任务都可能错过退出事件。这个校正只在挂载/切会话/回到前台时各跑一次，
   * 不轮询。
   */
  useReconcileRunningShells(sessionId, directory, serverId)
  const sectionVisible = useCallback(
    (id: Parameters<typeof isWorkStatusSectionVisible>[1]) => isWorkStatusSectionVisible(state.hidden, id),
    [state.hidden],
  )

  // 内容只在收起动画结束后才丢弃，卡片带着内容淡出而不是先清空；
  // 订阅也随之真正停止
  const [contentMounted, setContentMounted] = useState(visible)
  const allSectionsHidden = areAllWorkStatusSectionsHidden(state.hidden)

  // 隐藏或收起中：卡片不是用户能操作的东西。
  // visible 但所有板块都隐藏时，面板保持可交互，好让配置按钮仍然够得着——
  // 否则就没有恢复的入口了。
  const interactive = visible && (renderedSections > 0 || allSectionsHidden)

  useEffect(() => {
    if (visible) {
      setContentMounted(true)
      return undefined
    }
    const timer = window.setTimeout(() => setContentMounted(false), PANEL_TRANSITION_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  // 恢复偏移必须在滚动器挂载的那一刻发生，而面板会随上下文面板打开而卸载。
  // 通过 ref 读存储值，让这里成为挂载时的一次恢复，而不是会和用户滚动打架的订阅。
  const restoreScroll = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const stored = workStatusStore.getScrollTop()
    if (stored > 0) node.scrollTop = stored
  }, [])

  // 每帧合并成一次写入：scroll 触发频率远高于 store 需要知道的频率
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop } = event.currentTarget
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      workStatusStore.setScrollTop(scrollTop)
    })
  }, [])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  // 偏移属于某个会话产生的面板，而不属于面板本身：
  // 把一个会话的滚动位置恢复进另一个更短的面板会停在任意位置
  useEffect(() => {
    workStatusStore.setScrollTop(0)
  }, [sessionId])

  // 板块元素在 useMemo 里创建，展开态由各折叠板块自己订阅 store，
  // 因此这里不需要把展开态放进依赖。
  const sectionContext = useMemo(
    () => ({ sessionId, directory, serverId, contextLimit, onScrollToMessage }),
    [sessionId, directory, serverId, contextLimit, onScrollToMessage],
  )

  // 让这些元素由面板自己持有：主要读数的更新不会通过组合回调重渲无关板块
  const secondarySections = useMemo(
    () => ({
      turnStats: <WorkStatusTurnStatsSection {...sectionContext} />,
      subagents: <WorkStatusSubagentsSection {...sectionContext} />,
      backgroundJobs: <WorkStatusBackgroundJobsSection {...sectionContext} />,
      todos: <WorkStatusTasksSection {...sectionContext} />,
      mcp: <WorkStatusMcpSection {...sectionContext} />,
      pinnedMessages: <WorkStatusPinnedSection {...sectionContext} />,
    }),
    [sectionContext],
  )

  const primarySections = useMemo(
    () => ({
      session: <WorkStatusSessionSection {...sectionContext} />,
      project: <WorkStatusProjectSection {...sectionContext} />,
    }),
    [sectionContext],
  )

  // 统计实际渲染出的板块数，用于判断卡片是否应该保持可交互
  const renderedCount = useMemo(() => {
    const primaryCount = (sectionVisible('session') ? 1 : 0) + (sectionVisible('project') ? 1 : 0)
    const secondaryCount = sectionOrder.filter(
      id => id !== 'session' && id !== 'project' && sectionVisible(id),
    ).length
    return primaryCount + secondaryCount
  }, [sectionOrder, sectionVisible])

  useEffect(() => {
    setRenderedSections(renderedCount)
  }, [renderedCount])

  return (
    <aside
      aria-label={t('chat:workStatus.ariaLabel')}
      aria-hidden={!interactive}
      // 卡片在隐藏时保持挂载，好让它自己播完收起动画；
      // 配置按钮位于内容门之外。没有 inert 时 Tab 会落到不可见控件上——
      // 而 aria-hidden 包着可聚焦后代本身就是无障碍缺陷。
      inert={!interactive}
      className={cn(
        // self-start 让卡片保持内容高度而不是被拉伸到整行；
        // max-h 再封顶，长面板滚动而不是溢出对话
        'relative flex shrink-0 flex-col self-start overflow-hidden',
        // 顶栏是绝对定位的覆盖式布局：上边距 = 顶栏高度 + 呼吸间距，
        // 卡片才落在顶栏下方而不是贴住它。高度读 --chat-header-height，与 Header 同源。
        'mt-[calc(var(--chat-header-height,2.75rem)+var(--app-safe-top,0px)+0.75rem)] mb-3',
        // 上限扣掉顶栏、上下两段间距，避免长面板把底部顶出可视区
        'max-h-[calc(100%-var(--chat-header-height,2.75rem)-var(--app-safe-top,0px)-1.5rem)]',
        interactive ? 'ml-2 mr-4' : 'ml-0 mr-0',
        'motion-reduce:transition-none',
        'rounded-xl border border-border-200/50 bg-bg-100/40',
        'shadow-[0_2px_8px_-3px_hsl(var(--always-black)/0.08)]',
      )}
      style={{
        width: interactive ? WORK_STATUS_PANEL_WIDTH : 0,
        opacity: interactive ? 1 : 0,
        transform: visible ? 'translateX(0)' : `translateX(${WORK_STATUS_PANEL_WIDTH / 4}px)`,
        transformOrigin: 'top right',
        transitionProperty: 'width, opacity, transform, margin',
        transitionDuration: `${PANEL_TRANSITION_MS}ms`,
        transitionTimingFunction: PANEL_TRANSITION_EASING,
        pointerEvents: interactive ? undefined : 'none',
      }}
    >
      {/* 覆盖在内容上而不是占一行：面板没有自己的标题栏，
          加一个会在每个会话都多花一行高度 */}
      <IconButton
        aria-label={t('chat:workStatus.sections.open')}
        title={t('chat:workStatus.sections.open')}
        size="sm"
        onClick={() => setSectionsDialogOpen(true)}
        className="absolute right-2 top-1.5 z-10 text-text-500 hover:text-text-100"
      >
        <CogIcon size={14} />
      </IconButton>

      {contentMounted ? (
        <div
          ref={restoreScroll}
          onScroll={handleScroll}
          // 板块返回 null 时不留 DOM 节点，所以给首个渲染出的标题行预留配置按钮的位置，
          // 与保存的顺序无关
          className="oc-hide-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2.5 [&>section:first-child>[data-work-status-heading]]:pr-6"
        >
          {sectionOrder.map(id => {
            if (!sectionVisible(id)) return null
            // 用 Fragment 而非 <div className="contents">：板块之间的分隔线
            // 依赖 [&:not(:first-child)]，而 display:contents 的包裹元素仍是
            // DOM 父节点，会让每个板块都变成「父元素的第一个子元素」，
            // :not(:first-child) 永不匹配，分隔线一条都出不来。
            return (
              <Fragment key={id}>
                {id === 'session' || id === 'project' ? primarySections[id] : secondarySections[id]}
              </Fragment>
            )
          })}
        </div>
      ) : null}

      {contentMounted && allSectionsHidden ? (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <span className="text-[length:var(--fs-sm)] text-text-500">{t('chat:workStatus.sections.allHidden')}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSectionsDialogOpen(true)}
            className="mt-2 text-text-400"
          >
            {t('chat:workStatus.sections.open')}
          </Button>
        </div>
      ) : null}

      <WorkStatusSectionsDialog isOpen={sectionsDialogOpen} onClose={() => setSectionsDialogOpen(false)} />
    </aside>
  )
})
