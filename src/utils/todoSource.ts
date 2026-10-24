// ============================================
// todoSource - 从消息流推导会话的 todo 列表
// ============================================
//
// 为什么需要它：v2 后端**没有** todo 的数据通道 ——
//   - 没有 `todo.updated` 事件（协议里根本不存在该事件类型）
//   - 没有 `session/{id}/todo` 查询端点（实测 404）
//
// v2 表达 todo 的唯一方式是 agent 调用 `todowrite` 工具，待办内容在
// `tool.state.input.todos` 里。每次调用都会带上**完整列表**（不是增量），
// 所以「消息流里最后一条 todowrite 的 input」就是当前 todo 状态。
//
// 因此这里把消息流投影成 todoStore 的数据源：
//   - 流式期间：新出现的 todowrite part 到达即写入
//   - 打开历史会话：加载完成后整体投影一次
//
// 只认最后一次：早期调用是历史快照，覆盖上去会让已完成的任务"退回"未完成。

import type { Message, ToolContent } from '../types/message'
import type { TodoItem } from '../types/api/event'
import { todoStore } from '../store/todoStore'

/** 表达 todo 的工具名（v2 实测为 todowrite） */
const TODO_TOOL_NAMES = new Set(['todowrite', 'todo_write', 'todoread'])

function isTodoTool(part: Message['content'][number]): part is ToolContent {
  if (part.type !== 'tool') return false
  const name = part.tool?.toLowerCase()
  return !!name && TODO_TOOL_NAMES.has(name)
}

function isTodoStatus(status: unknown): status is TodoItem['status'] {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
}

function isTodoPriority(priority: unknown): priority is TodoItem['priority'] {
  return priority === 'high' || priority === 'medium' || priority === 'low'
}

/**
 * 把 todowrite 的 input.todos 归一成 TodoItem[]。
 *
 * 服务端给的形状已经比较规整，但仍做一次收窄：历史数据里出现过缺 priority、
 * 或 status 用了别的词的情况，直接透传会让 UI 的分组/图标取不到分支。
 */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const todos: TodoItem[] = []
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const todo = entry as Record<string, unknown>
    const content = typeof todo.content === 'string' ? todo.content : ''
    if (!content) return
    todos.push({
      id: `todo-${index}-${content.slice(0, 32)}`,
      content,
      status: isTodoStatus(todo.status) ? todo.status : 'pending',
      priority: isTodoPriority(todo.priority) ? todo.priority : 'medium',
    })
  })
  return todos
}

/** 从单个 tool part 取 todo 列表；不是 todo 工具或没有内容时返回 null */
function todosFromPart(part: Message['content'][number]): TodoItem[] | null {
  if (!isTodoTool(part)) return null
  const input = part.state?.input as Record<string, unknown> | undefined
  const raw = input?.todos
  if (!Array.isArray(raw)) return null
  return normalizeTodos(raw)
}

/**
 * 从整段消息里找出**最后一条** todowrite 的 todo 列表。
 *
 * 返回 null 表示这段消息里从未调用过 todowrite（此时不应清空已有状态，
 * 调用方据此决定是否写入）。
 */
export function extractLatestTodos(messages: Message[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== 'assistant') continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const todos = todosFromPart(message.content[j])
      if (todos) return todos
    }
  }
  return null
}

/**
 * 把消息流投影进 todoStore。
 *
 * `sessionKey` 必须是带服务器前缀的复合 key（与 useTodos 的读取口径一致）。
 */
export function syncTodosFromMessages(sessionKey: string | null, messages: Message[]): void {
  if (!sessionKey || messages.length === 0) return
  const todos = extractLatestTodos(messages)
  if (todos === null) return
  const current = todoStore.getTodos(sessionKey)
  if (isSameTodos(current, todos)) return
  todoStore.setTodos(sessionKey, todos)
}

function isSameTodos(a: TodoItem[], b: TodoItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].content !== b[i].content) return false
    if (a[i].status !== b[i].status) return false
    if (a[i].priority !== b[i].priority) return false
  }
  return true
}
