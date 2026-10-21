import { z } from 'zod'
import { createStore } from '../storage/createStore'
import { subscribePerServerStorageVersion } from '../utils/perServerStorage'
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

/**
 * 用户主动隐藏的项目目录。
 *
 * 侧栏里「服务器当前 worktree」会自动置顶成一个派生项目（见 useProjectGroups），
 * 它不在 saved-directories 里，因此「移除」对它无效 —— 点完刷新就回来。
 * 这份列表让「不想要它」这件事可持久化：命中的目录不再渲染，
 * 用户重新添加该目录时会自动移出（见 unhideProject）。
 */
const hiddenProjectsSchema: z.ZodType<string[]> = z.array(z.unknown()).transform(items =>
  Array.from(
    new Set(
      items
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map(item => normalizeToForwardSlash(item)),
    ),
  ),
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

const hiddenStore = createStore({
  key: 'opencode-hidden-projects',
  scope: { kind: 'server', serverId: 'local' },
  schema: hiddenProjectsSchema,
  defaultValue: [],
})

function ensureBound() {
  const serverId = activeServerId()
  if (bound?.serverId === serverId) return
  bound = { serverId, stores: { saved: savedStore, recent: recentStore } }
  savedStore.rebind(serverId)
  recentStore.rebind(serverId)
  hiddenStore.rebind(serverId)
}

/**
 * 让三个 store 跟随「外部写入」重读。
 *
 * 偏好同步引擎为了保留原始字符串，绕过 serverStorage 直接写 localStorage，
 * 只发一个版本通知（notifyPerServerStorageChanged）。createStore 只认自己的
 * commit 和跨标签页 storage 事件，收不到这个通知 —— 数据已经落盘、快照却还是
 * 启动时那份，于是「同步成功了但项目列表不变，必须刷新页面」。
 *
 * 另外直接绑一次，覆盖「本模块加载前就已发生过外部写入」的情况。
 */
subscribePerServerStorageVersion(() => {
  savedStore.reload()
  recentStore.reload()
  hiddenStore.reload()
})

/** 仅测试用：丢弃内存快照，强制下次访问重新读存储 */
export function resetAppDataBindingForTests(): void {
  bound = null
  savedStore.reset()
  recentStore.reset()
  hiddenStore.reset()
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
  /** 外部（同步引擎）写入后重读，见 createStore.reload */
  reload() {
    ensureBound()
    savedStore.reload()
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
  reload() {
    ensureBound()
    recentStore.reload()
  },
}

/** 被用户隐藏的项目目录 store */
export const hiddenProjectsStore = {
  get(): string[] {
    ensureBound()
    return hiddenStore.get()
  },
  commit(mutator: Parameters<typeof hiddenStore.commit>[0]) {
    ensureBound()
    hiddenStore.commit(mutator)
  },
  subscribe(listener: () => void) {
    ensureBound()
    return hiddenStore.subscribe(listener)
  },
  reload() {
    ensureBound()
    hiddenStore.reload()
  },
}

/** 隐藏一个项目目录（幂等）。 */
export function hideProject(directory: string): void {
  const normalized = normalizeToForwardSlash(directory)
  if (!normalized) return
  hiddenProjectsStore.commit(prev => (prev.includes(normalized) ? prev : [...prev, normalized]))
}

/** 取消隐藏（用户重新添加该项目时调用，避免「加了却看不见」）。 */
export function unhideProject(directory: string): void {
  const normalized = normalizeToForwardSlash(directory)
  if (!normalized) return
  hiddenProjectsStore.commit(prev => {
    const next = prev.filter(item => item !== normalized)
    return next.length === prev.length ? prev : next
  })
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
  hiddenStore.rebind(targetServerId)
  bound = { serverId: targetServerId, stores: { saved: savedStore, recent: recentStore } }
}

/** 显式记录最近使用时间（替代原先散落在 setCurrentDirectory 里的写入） */
export function touchRecentProject(directory: string): void {
  if (!directory) return
  recentProjectsStore.commit(prev => ({ ...prev, [directory]: Date.now() }))
}
