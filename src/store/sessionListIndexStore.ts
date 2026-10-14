// ============================================
// sessionListIndexStore - 按服务器 + 目录分桶的会话列表索引
// ============================================
//
// 解决的问题：会话列表原先存在各组件本地 state 里，切服务器 / 切项目时
// 组件被卸载重建（FolderRecentList 的 section 挂在 key={project.id} 上），
// state 归零，于是「已加载完 → 切走 → 切回」会重新转圈、重新拉取。
//
// 本 store 把列表提到组件之外，按 `serverId + 目录 + 视图(active/archived)`
// 分桶长期维护，并吃 SSE 增量（session.created/updated/deleted），于是：
//   - 组件重挂时同步读到已有内容，首帧即有数据，不闪 loading
//   - 切回访问过的主机拿到的是**当前准确**的列表，而不是最长 30s 前的快照
//
// 排序由 store 负责（不在读取侧做），固定「最新对话置顶」：
//   - 排序依据是用户最后一条消息的锚点时间（见 sessionActivityStore），
//     不是会话的 time.updated —— 后者会被 assistant 流式输出持续刷新，
//     多个会话并行运行时交替变化，按它排序会让列表来回跳。
//   - 整桶替换 / 新会话：按锚点排序插入
//   - 已有会话的字段更新：位置不动，避免流式期间列表重排。
//
// 不负责的事：
//   - 网络请求（由 hook 成功时 replace 进来）
//   - 搜索（搜索结果瞬态、高基数，不入索引，见 isIndexableQuery）

import type { ApiSession } from '../api/types'
import { normalizeForComparison } from '../utils/directoryUtils'
import { stripSessionListDetails } from '../api/sanitize'
import { isEphemeralSession } from '../utils/ephemeralSessions'
import { sessionActivityStore, sortSessionsByAnchor, insertSessionByAnchor } from './sessionActivityStore'

/** 视图分桶：活跃（不含归档）/ 归档 */
export type SessionListView = 'active' | 'archived'

/**
 * 单个桶的键。
 *
 * 目录用 normalizeForComparison（正斜杠 + 去尾斜杠 + 小写）而不是原始字符串：
 * 服务端事件里的 directory 与本地项目路径可能斜杠方向 / 大小写 / 尾部斜杠不同，
 * 用原串做键会算出两个桶，事件增量就落不进列表正在用的那个桶。
 *
 * `directory === undefined` 表示「该服务器的全局列表」（SessionContext 用）。
 *
 * `scope` 区分「同一 server + 目录、但分页语义不同」的多个消费方：
 * 侧栏每个项目按 5 条分页，SessionContext 的上下条导航按 30 条。
 * 二者若共用一个桶，会互相覆盖对方的 loadedLimit。
 */
export interface SessionListBucketKey {
  serverId: string
  directory: string | undefined
  view: SessionListView
  /** 消费方标识；缺省 ''（当作同一默认分页作用域） */
  scope?: string
}

interface Bucket {
  key: SessionListBucketKey
  /** 已按偏好排序的会话。就地更新时保持位置不变。 */
  items: ApiSession[]
  /**
   * 已「完整加载」的条数上限（分页）。
   *
   * 用户点「展开更多」会把 limit 增大，这个值随之上调；重挂时按它切片，
   * 否则展开过 20 条、切走切回会缩回 5 条。
   */
  loadedLimit: number
  /** 是否还有更多（服务端返回条数超过 limit） */
  hasMore: boolean
  /** 最近一次成功拉取的时间；用于 TTL 短路（避免刚拉过又拉） */
  fetchedAt: number
  /** 内容版本：任何变化都递增。快照缓存与重渲染的依据。 */
  contentRevision: number
  /**
   * 成员版本：仅当桶内「有哪些会话」变化时递增（整桶替换、新增、删除、
   * 归档迁移）。字段更新（标题等）不算。
   *
   * 用于处理「在途请求晚归」：请求发出时记下该版本，回来时若已变，
   * 说明期间成员增删过，直接覆盖会丢掉期间新增的会话，因此丢弃这次响应。
   */
  membershipRevision: number
  /**
   * 桶内会话的「墓碑」：被删掉的 sessionId。
   *
   * 事件删除与在途请求响应可能交错，墓碑保证已删项不会因晚归的响应复活；
   * 后续一次成功写入（整桶替换）会清空它。
   */
  tombstones: Set<string>
  /**
   * D15：该桶是否已成功拉取过。
   *
   * 此前用 `loadedLimit === 0` 判断「未加载」，但「已加载且确实为空」（如归档面板
   * 当前无归档会话）也会得到 0，导致此后所有 SSE 增量被 continue 丢弃，列表不再
   * 实时更新。用独立的 loaded 标志区分「从未加载」与「已加载但为空」。
   */
  loaded: boolean
  /** 最近一次访问时间，用于淘汰 */
  touchedAt: number
}

export interface WriteOptions {
  /** 该次写入对应的 limit，用于记录已加载条数 */
  limit: number
  /** 服务端是否还有更多（响应条数 > limit） */
  hasMore: boolean
  /**
   * 期望的成员版本。仅当桶当前成员版本等于它时才应用。
   * 用于在途请求晚归时判断期间成员是否发生了增删。
   */
  expectedMembershipRevision?: number
}

const MAX_BUCKETS = 200
const MAX_SESSIONS_PER_BUCKET = 500
const EMPTY_SESSIONS: ApiSession[] = []

function bucketId(key: SessionListBucketKey): string {
  return `${key.serverId}\u0000${normalizeForComparison(key.directory)}\u0000${key.view}\u0000${key.scope ?? ''}`
}

/** 搜索结果是瞬态高基数查询，不进索引 */
export function isIndexableQuery(query: { search?: string }): boolean {
  return !query.search
}

class SessionListIndexStore {
  private buckets = new Map<string, Bucket>()
  private subscribers = new Set<() => void>()
  /** 快照缓存：满足 useSyncExternalStore 对稳定引用的要求 */
  private snapshotCache = new Map<string, { revision: number; value: ApiSession[] }>()
  /** 全局版本号：任何桶内容变化都递增。用于多桶聚合时的订阅触发 */
  private version = 0

  constructor() {
    // 用户消息锚点变化时重排相关会话所在的桶（这是唯一会改变已有项顺序的时机）。
    // 锚点单调递增，只在用户发送/加载时抬高，流式 assistant 输出不会触发。
    sessionActivityStore.subscribe(change => {
      const rawId = change.sessionId
      if (!rawId) return
      let changed = false
      for (const bucket of this.buckets.values()) {
        if (bucket.items.length === 0) continue
        if (!bucket.items.some(item => item.id === rawId)) continue
        bucket.items = sortSessionsByAnchor(bucket.items)
        bucket.contentRevision++
        changed = true
      }
      if (changed) this.emit()
    })
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  private emit() {
    this.version++
    this.snapshotCache.clear()
    for (const fn of this.subscribers) fn()
  }

  /** 全局内容版本：任何桶变化都递增。供聚合读取侧作为 useMemo 依赖 */
  getVersion(): number {
    return this.version
  }

  private getOrCreate(key: SessionListBucketKey): Bucket {
    const id = bucketId(key)
    let bucket = this.buckets.get(id)
    if (!bucket) {
      bucket = {
        key,
        items: [],
        loadedLimit: 0,
        hasMore: false,
        fetchedAt: 0,
        contentRevision: 0,
        membershipRevision: 0,
        tombstones: new Set(),
        loaded: false,
        touchedAt: Date.now(),
      }
      this.buckets.set(id, bucket)
      this.pruneIfNeeded()
    }
    return bucket
  }

  /**
   * 快照：该桶当前排好序的会话数组。引用稳定，内容变才换新引用。
   * 供 useSyncExternalStore 使用。
   */
  getSnapshot = (key: SessionListBucketKey): ApiSession[] => {
    const id = bucketId(key)
    const bucket = this.buckets.get(id)
    if (!bucket) return EMPTY_SESSIONS

    const cached = this.snapshotCache.get(id)
    if (cached && cached.revision === bucket.contentRevision) return cached.value

    const value = bucket.items.slice()
    this.snapshotCache.set(id, { revision: bucket.contentRevision, value })
    return value
  }

  /** 读取桶内容（已裁剪、已排序）。未命中返回 undefined。 */
  get(key: SessionListBucketKey): ApiSession[] | undefined {
    const bucket = this.buckets.get(bucketId(key))
    if (!bucket) return undefined
    bucket.touchedAt = Date.now()
    return bucket.items.slice()
  }

  /** 该桶是否已有内容（用于决定重挂首帧要不要显示 loading） */
  has(key: SessionListBucketKey): boolean {
    const bucket = this.buckets.get(bucketId(key))
    return !!bucket && bucket.loadedLimit > 0
  }

  /** 该桶已加载到的条数上限（分页保留用） */
  getLoadedLimit(key: SessionListBucketKey): number {
    return this.buckets.get(bucketId(key))?.loadedLimit ?? 0
  }

  getHasMore(key: SessionListBucketKey): boolean {
    return this.buckets.get(bucketId(key))?.hasMore ?? false
  }

  /** 最近一次成功拉取的时间戳；0 表示从未拉过 */
  getFetchedAt(key: SessionListBucketKey): number {
    return this.buckets.get(bucketId(key))?.fetchedAt ?? 0
  }

  /** 当前桶成员版本（发请求前取，回包时校验） */
  getMembershipRevision(key: SessionListBucketKey): number {
    return this.buckets.get(bucketId(key))?.membershipRevision ?? 0
  }

  /**
   * 整桶替换（网络请求成功后调用）。
   *
   * 保留墓碑：期间被事件删掉的会话不写回。写完清空墓碑——这份响应已经
   * 是服务端的最新全量，删除的信息已经包含在内。
   */
  replace(key: SessionListBucketKey, sessions: ApiSession[], options: WriteOptions): void {
    const bucket = this.getOrCreate(key)
    if (
      options.expectedMembershipRevision !== undefined &&
      bucket.membershipRevision !== options.expectedMembershipRevision
    ) {
      // 期间有增删/归档迁移，直接覆盖会丢掉这些变化，丢弃这次响应
      return
    }

    const stripped = sessions
      .filter(session => !bucket.tombstones.has(session.id))
      .map(stripSessionListDetails)

    bucket.items = sortSessionsByAnchor(stripped)
    bucket.loadedLimit = options.limit
    bucket.hasMore = options.hasMore
    bucket.fetchedAt = Date.now()
    // D15：标记已加载。空列表也算「已加载但为空」，此后仍接受 SSE 增量。
    bucket.loaded = true
    bucket.tombstones.clear()
    bucket.contentRevision++
    bucket.membershipRevision++
    bucket.touchedAt = Date.now()
    this.pruneBucketSize(bucket)
    this.emit()
  }

  /**
   * 增量插入 / 更新单个会话（本地新建等已知归属的场景）。
   * 只作用于「已加载过」的桶：未加载过说明这个目录还没被打开，
   * 凭单条记录建桶不如等真正打开时拉全量准确。
   */
  upsert(key: SessionListBucketKey, session: ApiSession): void {
    const bucket = this.buckets.get(bucketId(key))
    // D15：用 loaded 判定「是否已加载过」，而非 loadedLimit>0（空桶也应是已加载）
    if (!bucket || !bucket.loaded) return
    if (bucket.tombstones.has(session.id)) return
    if (this.writeIntoBucket(bucket, session)) this.emit()
  }

  /**
   * 跨该服务器所有桶对指定会话做字段补丁（重命名等只带部分字段的增量事件）。
   * 只改已存在条目的字段，不新增成员、不动位置。
   */
  patchAll(serverId: string, sessionId: string, patch: Partial<ApiSession>): void {
    let changed = false
    for (const bucket of this.buckets.values()) {
      if (bucket.key.serverId !== serverId) continue
      const index = bucket.items.findIndex(session => session.id === sessionId)
      if (index === -1) continue
      bucket.items[index] = { ...bucket.items[index], ...patch }
      bucket.contentRevision++
      bucket.touchedAt = Date.now()
      changed = true
    }
    if (changed) this.emit()
  }

  /**
   * 本地字段补丁（重命名等乐观更新）。只改已有条目的字段，不动位置。
   * 返回是否命中并更新。
   */
  patch(key: SessionListBucketKey, sessionId: string, patch: Partial<ApiSession>): boolean {
    const bucket = this.buckets.get(bucketId(key))
    if (!bucket) return false
    const index = bucket.items.findIndex(session => session.id === sessionId)
    if (index === -1) return false
    bucket.items[index] = { ...bucket.items[index], ...patch }
    bucket.contentRevision++
    bucket.touchedAt = Date.now()
    this.emit()
    return true
  }

  /** 从指定桶移除（删除事件 / 归档迁移的源桶） */
  remove(key: SessionListBucketKey, sessionId: string): void {
    const bucket = this.buckets.get(bucketId(key))
    if (!bucket) return
    const index = bucket.items.findIndex(session => session.id === sessionId)
    const removed = index !== -1
    if (removed) bucket.items.splice(index, 1)
    // 无论是否在桶里都记墓碑：晚归的在途响应可能把它带回来
    bucket.tombstones.add(sessionId)
    bucket.touchedAt = Date.now()
    if (removed) {
      bucket.contentRevision++
      bucket.membershipRevision++
      this.emit()
    }
  }

  /**
   * 删除事件：该服务器下所有桶都移除该会话（含归档桶）。
   * 每个桶都记墓碑，挡住晚归的在途响应。
   */
  applyDeleted(serverId: string, sessionId: string): void {
    let changed = false
    for (const bucket of this.buckets.values()) {
      if (bucket.key.serverId !== serverId) continue
      bucket.tombstones.add(sessionId)
      const index = bucket.items.findIndex(session => session.id === sessionId)
      if (index !== -1) {
        bucket.items.splice(index, 1)
        bucket.contentRevision++
        bucket.membershipRevision++
        bucket.touchedAt = Date.now()
        changed = true
      }
    }
    if (changed) this.emit()
  }

  /**
   * 创建 / 更新事件：按会话的 directory 与归档态路由到对应桶。
   *
   * 子会话（有 parentID）不进列表：列表按 roots 拉，子会话归 childSessionStore。
   *
   * 内部临时会话（AI 重命名等）一律不进列表：若事件先于创建方登记到达、
   * 已被插进桶里，这里把它摘掉（含墓碑，挡住晚归的在途响应）。
   */
  applySessionChanged(serverId: string, session: ApiSession): void {
    if (isEphemeralSession(session.id)) {
      let changed = false
      for (const bucket of this.buckets.values()) {
        if (bucket.key.serverId !== serverId) continue
        bucket.tombstones.add(session.id)
        const index = bucket.items.findIndex(item => item.id === session.id)
        if (index !== -1) {
          bucket.items.splice(index, 1)
          bucket.contentRevision++
          bucket.membershipRevision++
          bucket.touchedAt = Date.now()
          changed = true
        }
      }
      if (changed) this.emit()
      return
    }
    if (session.parentID) return

    const dir = normalizeForComparison(session.directory)
    const archived = Boolean(session.time?.archived)
    const view: SessionListView = archived ? 'archived' : 'active'
    let changed = false

    for (const bucket of this.buckets.values()) {
      if (bucket.key.serverId !== serverId) continue

      // 全局桶（directory 为空）对所有目录生效；按目录的桶要求目录一致
      const bucketDir = normalizeForComparison(bucket.key.directory)
      if (bucketDir !== '' && bucketDir !== dir) continue

      const shouldBePresent = bucket.key.view === view
      if (!shouldBePresent) {
        // 归档态变了：从另一个视图的桶里摘掉。
        // D3：同时记墓碑，挡住此前针对该桶发出的、晚归的分页响应（响应里仍带着
        // 旧视图的这条会话）。没有墓碑时它会被 replace 写回，归档会话在活跃列表复活。
        bucket.tombstones.add(session.id)
        const index = bucket.items.findIndex(item => item.id === session.id)
        if (index !== -1) {
          bucket.items.splice(index, 1)
          bucket.contentRevision++
          bucket.membershipRevision++
          bucket.touchedAt = Date.now()
          changed = true
        }
        continue
      }

      // 会话确实属于该视图：清除此前可能残留的墓碑（例如取消归档 / 归档后恢复），
      // 否则晚归响应或后续写入会被墓碑挡掉，会话无法回到列表。
      bucket.tombstones.delete(session.id)
      // D15：用 loaded 判定「已加载过」；空桶也应接受增量
      if (!bucket.loaded) continue
      if (this.writeIntoBucket(bucket, session)) changed = true
    }

    if (changed) this.emit()
  }

  /** 更新分页上限（loadMore 后由列表记录） */
  setLoadedLimit(key: SessionListBucketKey, limit: number, hasMore: boolean): void {
    const bucket = this.buckets.get(bucketId(key))
    if (!bucket) return
    if (bucket.loadedLimit === limit && bucket.hasMore === hasMore) return
    bucket.loadedLimit = limit
    bucket.hasMore = hasMore
    bucket.touchedAt = Date.now()
    this.emit()
  }

  /** 服务器被移除时清理其所有桶，避免僵尸数据长期占内存 */
  dropServer(serverId: string): void {
    let changed = false
    for (const [id, bucket] of [...this.buckets.entries()]) {
      if (bucket.key.serverId === serverId) {
        this.buckets.delete(id)
        this.snapshotCache.delete(id)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  /** 单测用：清空全部 */
  reset(): void {
    this.buckets.clear()
    this.snapshotCache.clear()
    this.emit()
  }

  /**
   * 把一个会话写进桶（去重 + 版本语义）。返回内容是否真的变了。
   * 已存在则就地替换（位置不变）；否则按锚点插入到正确位置。
   */
  private writeIntoBucket(bucket: Bucket, session: ApiSession): boolean {
    if (isEphemeralSession(session.id)) return false
    const stripped = stripSessionListDetails(session)
    const index = bucket.items.findIndex(item => item.id === session.id)

    if (index === -1) {
      bucket.items = insertSessionByAnchor(bucket.items, stripped)
      bucket.membershipRevision++
    } else {
      if (isSameSessionSummary(bucket.items[index], stripped)) return false
      // 就地替换：位置不动
      bucket.items[index] = stripped
    }

    bucket.contentRevision++
    bucket.touchedAt = Date.now()
    this.pruneBucketSize(bucket)
    return true
  }

  private pruneBucketSize(bucket: Bucket): void {
    if (bucket.items.length <= MAX_SESSIONS_PER_BUCKET) return
    // 超出上限时丢末尾（按偏好排序后末尾是最不需要的）
    bucket.items = bucket.items.slice(0, MAX_SESSIONS_PER_BUCKET)
  }

  private pruneIfNeeded(): void {
    if (this.buckets.size <= MAX_BUCKETS) return
    // 按 touchedAt 淘汰最久未使用的桶
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    const excess = this.buckets.size - MAX_BUCKETS
    for (let i = 0; i < excess; i++) {
      this.buckets.delete(entries[i][0])
      this.snapshotCache.delete(entries[i][0])
    }
  }
}

/** 轻量比较：只比较列表渲染会读的字段，避免无谓的 emit 与重渲染 */
function isSameSessionSummary(a: ApiSession, b: ApiSession): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.directory === b.directory &&
    a.time?.updated === b.time?.updated &&
    a.time?.archived === b.time?.archived &&
    a.parentID === b.parentID
  )
}

export const sessionListIndexStore = new SessionListIndexStore()

export type { SessionListIndexStore }
