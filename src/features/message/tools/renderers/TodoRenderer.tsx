import { useTranslation } from 'react-i18next'
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
  // 实时状态以 todoStore 为准（由 utils/todoSyncBridge 从消息流的 todowrite
  // 投影进来 —— v2 没有 todo.updated 事件）；卡片自带的 input 快照作为
  // store 尚未收到数据时的兜底（如刚打开的历史消息）。
  const storeTodos = useTodos(currentSessionId ?? null)
  const todos: TodoItem[] = storeTodos.length > 0 ? storeTodos : extractTodos(part)

  if (todos.length === 0) {
    return null
  }

  return <TodoList todos={todos} stateKey={`message:${part.messageID}:tool:${part.id}:todo-list`} />
}

// ============================================
// TodoList Component
// ============================================

function TodoList({ todos, stateKey }: { todos: TodoItem[]; stateKey: string }) {
  const { t } = useTranslation('message')
  const [collapsed, setCollapsed] = useUiDisclosureState(stateKey, false)
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
