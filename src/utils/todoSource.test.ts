/**
 * todoSource - 从消息流推导 todo
 *
 * v2 没有 todo 的数据通道（无 todo.updated 事件、无查询端点），todo 只存在于
 * agent 的 todowrite 工具调用里。这里固定「取最后一条 todowrite」的语义。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { extractLatestTodos, normalizeTodos, syncTodosFromMessages } from './todoSource'
import { todoStore } from '../store/todoStore'
import type { Message } from '../types/message'

function todoTool(id: string, todos: unknown): Message['content'][number] {
  return {
    type: 'tool',
    id,
    callID: `call-${id}`,
    tool: 'todowrite',
    state: { status: 'completed', input: { todos } },
  } as unknown as Message['content'][number]
}

function assistant(id: string, content: Message['content'][number] | Message['content']): Message {
  return {
    info: { id, role: 'assistant', time: { created: 1 }, tokens: {} },
    content: Array.isArray(content) ? content : [content],
  } as unknown as Message
}

function user(id: string, text: string): Message {
  return { info: { id, role: 'user', time: { created: 1 }, text }, content: [] } as unknown as Message
}

beforeEach(() => {
  todoStore.clearAll()
})

describe('normalizeTodos', () => {
  it('保留合法字段', () => {
    expect(normalizeTodos([{ content: 'a', status: 'in_progress', priority: 'high' }])).toEqual([
      { id: 'todo-0-a', content: 'a', status: 'in_progress', priority: 'high' },
    ])
  })

  it('缺失 status/priority 时补默认值', () => {
    const [todo] = normalizeTodos([{ content: 'a' }])
    expect(todo.status).toBe('pending')
    expect(todo.priority).toBe('medium')
  })

  it('非法 status 归为 pending', () => {
    const [todo] = normalizeTodos([{ content: 'a', status: 'doing' }])
    expect(todo.status).toBe('pending')
  })

  it('丢弃没有 content 的条目', () => {
    expect(normalizeTodos([{ status: 'pending' }, { content: '' }, { content: 'ok' }])).toHaveLength(1)
  })

  it('非数组返回空', () => {
    expect(normalizeTodos(undefined)).toEqual([])
    expect(normalizeTodos('x')).toEqual([])
  })
})

describe('extractLatestTodos', () => {
  it('取最后一条 todowrite 的完整列表（每次调用都是全量快照）', () => {
    const messages = [
      assistant('a1', todoTool('t1', [{ content: '任务1', status: 'in_progress' }])),
      assistant('a2', todoTool('t2', [
        { content: '任务1', status: 'completed' },
        { content: '任务2', status: 'in_progress' },
      ])),
    ]

    const todos = extractLatestTodos(messages)
    expect(todos?.map(t => `${t.content}:${t.status}`)).toEqual(['任务1:completed', '任务2:in_progress'])
  })

  it('从未调用 todowrite 时返回 null（不覆盖已有状态）', () => {
    expect(extractLatestTodos([user('u1', 'hi'), assistant('a1', {
      type: 'text', id: 'p1', text: 'hello',
    } as unknown as Message['content'][number])])).toBeNull()
  })

  it('忽略大小写差异', () => {
    const part = { ...todoTool('t1', [{ content: 'x', status: 'pending' }]), tool: 'TodoWrite' }
    expect(extractLatestTodos([assistant('a1', part as Message['content'][number])])).toHaveLength(1)
  })

  it('忽略其它工具', () => {
    const part = { ...todoTool('t1', [{ content: 'x' }]), tool: 'write' }
    expect(extractLatestTodos([assistant('a1', part as Message['content'][number])])).toBeNull()
  })

  it('同一条消息里有多个 todowrite 时取最后一个', () => {
    const message: Message = {
      info: { id: 'a1', role: 'assistant', time: { created: 1 }, tokens: {} },
      content: [
        todoTool('t1', [{ content: 'old', status: 'pending' }]),
        todoTool('t2', [{ content: 'new', status: 'completed' }]),
      ],
    } as unknown as Message

    expect(extractLatestTodos([message])?.[0].content).toBe('new')
  })
})

describe('syncTodosFromMessages', () => {
  const KEY = 'local::ses_1'

  it('把最后一条 todowrite 写进 store', () => {
    syncTodosFromMessages(KEY, [
      assistant('a1', todoTool('t1', [{ content: '写代码', status: 'in_progress', priority: 'high' }])),
    ])

    expect(todoStore.getTodos(KEY).map(t => t.content)).toEqual(['写代码'])
    expect(todoStore.getStats(KEY)).toEqual({ total: 1, completed: 0, inProgress: 1 })
  })

  it('没有 todowrite 时不写入', () => {
    syncTodosFromMessages(KEY, [user('u1', 'hi')])
    expect(todoStore.getTodos(KEY)).toEqual([])
  })

  it('内容未变时不重复写入（流式期间避免无谓重渲染）', () => {
    const messages = [assistant('a1', todoTool('t1', [{ content: 'a', status: 'pending' }]))]
    syncTodosFromMessages(KEY, messages)
    const revision = todoStore.getRevision(KEY)

    syncTodosFromMessages(KEY, messages)

    expect(todoStore.getRevision(KEY)).toBe(revision)
  })

  it('状态变化时写入', () => {
    syncTodosFromMessages(KEY, [assistant('a1', todoTool('t1', [{ content: 'a', status: 'pending' }]))])
    syncTodosFromMessages(KEY, [assistant('a1', todoTool('t1', [{ content: 'a', status: 'completed' }]))])

    expect(todoStore.getTodos(KEY)[0].status).toBe('completed')
  })

  it('sessionKey 为空时安全 no-op', () => {
    expect(() => syncTodosFromMessages(null, [assistant('a1', todoTool('t1', [{ content: 'a' }]))])).not.toThrow()
    expect(todoStore.getTodos('local::ses_1')).toEqual([])
  })
})
