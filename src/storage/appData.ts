import { z } from 'zod'
import { createStore } from '../storage/createStore'
import { isAbsoluteDirectory, normalizeToForwardSlash } from '../utils'
import { serverStore } from '../store/serverStore'
import type { SavedDirectory } from '../contexts/DirectoryContext.shared'

// ============================================
// 项目目录列表 / 最近使用记录
// ============================================
//
// 这两份数据都按服务器分桶。历史上的「项目添加后消失」「读一个桶写另一个桶」
// 都源于读写各自隐式取「当前活动服务器」；这里改为启动即绑定 activeServerId，
// 服务器切换时 rebind，读写永远指向同一个桶。

/** 丢弃历史脏数据（相对路径等），并把缺失字段补全 */
const savedDirSchema: z.ZodType<SavedDirectory[]> = z.array(z.unknown()).transform(items =>
  items.flatMap(item => {
    const record = item as { path?: unknown; name?: unknown; addedAt?: unknown }
    if (!record || typeof record.path !== 'string') return []
    const path = record.path
    if (!isAbsoluteDirectory(normalizeToForwardSlash(path))) return []
    return [
      {
        path,
        name: typeof record.name === 'string' && record.name.trim() ? record.name : path,
        addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
      },
    ]
  }),
)

const recentSchema: z.ZodType<Record<string, number>> = z.record(z.string(), z.unknown()).transform(raw =>
  Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
)

const activeServerId = () => serverStore.getActiveServerId()

// 模块加载时 serverStore 可能尚未就绪（测试、SSR、启动早期），绑定放在首次
// 使用时进行：此时 activeServerId 已是最终值。
let bound: { serverId: string; stores: { saved: typeof savedStore; recent: typeof recentStore } } | null = null

const savedStore = createStore({
  key: 'opencode-saved-directories',
  scope: { kind: 'server', serverId: 'local' },
  schema: savedDirSchema,
  defaultValue: [],
})

const recentStore = createStore({
  key: 'opencode-recent-projects',
  scope: { kind: 'server', serverId: 'local' },
  schema: recentSchema,
  defaultValue: {},
})

function ensureBound() {
  const serverId = activeServerId()
  if (bound?.serverId === serverId) return
  bound = { serverId, stores: { saved: savedStore, recent: recentStore } }
  savedStore.rebind(serverId)
  recentStore.rebind(serverId)
}

/** 仅测试用：丢弃内存快照，强制下次访问重新读存储 */
export function resetAppDataBindingForTests(): void {
  bound = null
  savedStore.reset()
  recentStore.reset()
}

/** 项目列表 store（首次访问时绑定到当前活动服务器） */
export const savedDirectoriesStore = {
  get() {
    ensureBound()
    return savedStore.get()
  },
  commit(mutator: Parameters<typeof savedStore.commit>[0]) {
    ensureBound()
    savedStore.commit(mutator)
  },
  subscribe(listener: () => void) {
    ensureBound()
    return savedStore.subscribe(listener)
  },
  getStorageKey() {
    ensureBound()
    return savedStore.getStorageKey()
  },
}

/** 最近使用记录 store */
export const recentProjectsStore = {
  get() {
    ensureBound()
    return recentStore.get()
  },
  commit(mutator: Parameters<typeof recentStore.commit>[0]) {
    ensureBound()
    recentStore.commit(mutator)
  },
  subscribe(listener: () => void) {
    ensureBound()
    return recentStore.subscribe(listener)
  },
}

/**
 * 把两个 store 重新绑定到当前活动服务器。
 *
 * 由 DirectoryProvider 在服务器切换时调用，而不是在模块加载时注册全局监听：
 * 模块级副作用会让测试与 SSR 难以隔离，也让「谁负责 rebind」变得隐式。
 */
export function rebindAppData(targetServerId = activeServerId()): void {
  bound = null
  savedStore.rebind(targetServerId)
  recentStore.rebind(targetServerId)
  bound = { serverId: targetServerId, stores: { saved: savedStore, recent: recentStore } }
}

/** 显式记录最近使用时间（替代原先散落在 setCurrentDirectory 里的写入） */
export function touchRecentProject(directory: string): void {
  if (!directory) return
  recentProjectsStore.commit(prev => ({ ...prev, [directory]: Date.now() }))
}
