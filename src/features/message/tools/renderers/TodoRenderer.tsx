import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { CheckIcon, ClockIcon, CloseIcon, CircleIcon, ManageSessionsIcon } from '../../../../components/Icons'
import { DisclosureRow } from '../../../../components/ui/DisclosureRow'
import { ProgressBar } from '../../../../components/ui/ProgressBar'
import type { ToolRendererProps } from '../types'
import { useCompositorExpand, useDisclosureScrollLock } from '../../../../hooks'
import { extractTodos } from './todoUtils'
import { useUiDisclosureState } from '../../../../utils/uiDisclosureState'
import { MessageExpandPanel } from '../../messageExpand'
import { useMessageExpandRender } from '../../messageExpandShared'
import { useTodos } from '../../../../store'
import { useSessionNavigation } from '../../../../contexts/SessionNavigationContext'

// ============================================
// Types
// ============================================

interface TodoItem {
  id: string
  content: string
  status: string
  priority: string
}

// ============================================
// Todo Renderer
// ============================================

export function TodoRenderer({ part }: ToolRendererProps) {
  const { currentSessionId } = useSessionNavigation()
  const storeTodos = useTodos(currentSessionId ?? null)
  // ============================================
  // 渲染哪一份待办
  // ============================================
  //
  // 每个 todowrite part 携带的是**这一次调用**的完整快照，卡片必须只显示它自己
  // 那份 —— 那是这一轮真实发生的事，是历史记录。
  //
  // 之前的写法是「store 有数据就用 store」，看着能让流式中的卡片实时更新，
  // 实际有个严重后果：store 里只有「最后一次」的状态，而一个会话可能调用过
  // 多次 todowrite（实测一条会话有 2 次，5 条 → 7 条）。于是所有历史卡片都被
  // 替换成最新那 7 条，早期轮次的待办在消息流里彻底消失，用户以为「待办丢了」。
  //
  // 现在的取法：
  //   1. 优先用 part 自带的 input.todos（历史卡片 → 各显示各的）
  //   2. part 还没拿到 input 时（流式早期、或骨架投影剥掉了过程），退回 store
  // 面板（Tasks）仍然只显示最新一份，那是「当前进度」的正确语义。
  const ownTodos = extractTodos(part)
  const todos: TodoItem[] = ownTodos.length > 0 ? ownTodos : storeTodos

  if (todos.length === 0) {
    return null
  }

  /**
   * 默认折叠。
   *
   * 这张卡片渲染在过程折叠壳里（历史轮次），属于回顾性内容；默认展开会在
   * 对话结尾堆一大块列表。需要看时点一行标题即可，进度条本身仍然可见。
   */
  return (
    <TodoList
      todos={todos}
      stateKey={`message:${part.messageID}:tool:${part.id}:todo-list`}
      defaultCollapsed
    />
  )
}

// ============================================
// TodoList Component
// ============================================

export function TodoList({
  todos,
  stateKey,
  defaultCollapsed = false,
  /**
   * 是否遵循「已结束则默认收起」。
   *
   * 传 true 时：用户还没手动动过这张卡片的话，按 `defaultCollapsed` 决定；
   * 一旦用户点过，就完全按用户的选择，不再被自动收起覆盖。
   */
  autoCollapse = false,
}: {
  todos: TodoItem[]
  stateKey: string
  defaultCollapsed?: boolean
  autoCollapse?: boolean
}) {
  const { t } = useTranslation('message')
  const [collapsed, setCollapsed, touched] = useUiDisclosureState(stateKey, defaultCollapsed)
  /**
   * 会话跑完之后把待办卡片收起来。
   *
   * 待办的价值在「正在做什么」，轮次结束后它已变成历史记录 —— 常驻展开会在
   * 对话结尾留下一大块列表，把真正的回复推远。但用户手动点开过的卡片要尊重
   * 其选择（`touched`），否则每帧同步都会把用户刚点开的又收回去。
   */
  useEffect(() => {
    if (!autoCollapse || touched) return
    setCollapsed(defaultCollapsed, { touched: false })
  }, [autoCollapse, defaultCollapsed, setCollapsed, touched])
  // Android expand: 展开用 max-height 假高度，避免 WebView 在 grid-rows 动画中
  // 把任务列表画成空白（滚动中展开时闪一下）。
  const {
    contentRef: todoExpandContentRef,
    layoutOpen: todoLayoutOpen,
    keepMounted: todoKeepMounted,
    panelClassName: todoPanelClassName,
  } = useCompositorExpand(!collapsed)
  const shouldRenderBody = useMessageExpandRender(todoKeepMounted)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const completed = todos.filter(t => t.status === 'completed').length
  const total = todos.length
  const progress = total > 0 ? completed / total : 0
  const isAllDone = total > 0 && completed === total
  const percent = Math.round(progress * 100)

  return (
    <div
      ref={rootRef}
      className="border border-border-200/50 rounded-md overflow-hidden bg-bg-100 text-[length:var(--fs-sm)]"
    >
      <DisclosureRow
        ref={headerRef}
        expanded={!collapsed}
        onClick={() => withScrollLock(() => setCollapsed(!collapsed))}
        inset={false}
        className="rounded-none bg-bg-200/50 hover:bg-bg-200"
        icon={<ManageSessionsIcon size={13} className="text-text-500" />}
        label={<span className="font-mono text-text-300">{t('todo.tasks')}</span>}
        meta={
          <span className="flex items-center gap-2">
            <ProgressBar progress={progress} done={isAllDone} decorative className="w-12" />
            <span className="tabular-nums text-text-500">{t('todo.completedCount', { completed, total })}</span>
            <span
              className={`tabular-nums text-[length:var(--fs-xxs)] font-medium ${
                isAllDone ? 'text-success-100' : 'text-text-400'
              }`}
            >
              {percent}%
            </span>
          </span>
        }
      />

      {/* List */}
      <MessageExpandPanel
        open={todoLayoutOpen}
        panelClassName={todoPanelClassName}
        contentRef={todoExpandContentRef}
        innerClassName="overflow-hidden"
      >
        {shouldRenderBody && (
          <div className="divide-y divide-border-200/30">
            {todos.map(todo => (
              <div
                key={todo.id}
                className={`flex items-center gap-2 px-3 py-2 ${
                  todo.status === 'completed' ? 'text-text-500' : 'text-text-200'
                }`}
              >
                <span className="shrink-0 flex items-center">{getTodoIcon(todo.status)}</span>
                <span className={todo.status === 'completed' ? 'line-through' : ''}>{todo.content}</span>
                {todo.priority === 'high' && todo.status !== 'completed' && (
                  <span className="text-[length:var(--fs-xxs)] text-warning-100 bg-warning-100/10 px-1 rounded ml-auto shrink-0">
                    !
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
}

function getTodoIcon(status: string) {
  const size = 14

  switch (status) {
    case 'completed':
      return <CheckIcon size={size} className="text-text-400" strokeWidth={2.5} />
    case 'in_progress':
      return <ClockIcon size={size} className="text-accent-main-100" />
    case 'cancelled':
      return <CloseIcon size={size} className="text-text-500" />
    default:
      return <CircleIcon size={size} className="text-text-500" />
  }
}
