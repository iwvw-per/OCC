/**
 * overlayScrollbar — 全局自绘滚动条（垂直 + 水平）
 *
 * 隐藏浏览器原生滚动条，自动为所有可滚动容器注入 overlay thumb。
 *
 * 架构：
 *   CSS  * { scrollbar-width:none }              隐藏原生
 *   JS   MutationObserver 扫描 DOM → attach(el)  发现可滚动容器
 *        attach() → 在容器的父元素上创建 thumb     不随内容滚走
 *        scroll → getBoundingClientRect 定位       跟随容器视口
 *
 * 一个容器可以同时有垂直和水平两个 thumb。
 * scan 周期性检测方向变化，动态增删 thumb。
 *
 * thumb 挂在容器的父元素上：
 *   - 不被容器滚动带走
 *   - 不干扰 column-reverse 等 flex 布局
 *   - 受祖先 overflow 裁剪 → 容器消失 thumb 自然消失
 *
 * thumb 自身监听 pointerenter/pointerleave，
 * 防止鼠标从容器移向 thumb 时因 pointerleave 导致 thumb 消失。
 */

const ATTR = 'data-os'
const TRACK_PAD = 8
const MIN_THUMB = 32
const FADE_MS = 800

// ── 方向判断 ────────────────────────────────────────────

/** 带 no-scrollbar / scrollbar-none 的元素故意不要滚动条，跳过 */
function wantsNoScrollbar(el: HTMLElement): boolean {
  return el.classList.contains('no-scrollbar') || el.classList.contains('scrollbar-none')
}

/** 读取 overflow 样式并缓存：getComputedStyle 会强制样式重算，同一元素只读一次 */
function getOverflow(el: HTMLElement): { x: string; y: string; direction: string; flexDirection: string } {
  const cached = overflowCache.get(el)
  if (cached) return cached
  const style = getComputedStyle(el)
  const value = {
    x: style.overflowX,
    y: style.overflowY,
    direction: style.direction,
    flexDirection: style.flexDirection,
  }
  overflowCache.set(el, value)
  return value
}

let overflowCache = new WeakMap<HTMLElement, { x: string; y: string; direction: string; flexDirection: string }>()
function isScrollableY(el: HTMLElement): boolean {
  if (el === document.documentElement || el === document.body) return false
  if (el.tagName === 'INPUT') return false
  if (wantsNoScrollbar(el)) return false
  if (el.tagName === 'TEXTAREA') return el.scrollHeight > el.clientHeight + 1

  const oy = getOverflow(el).y
  if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false
  return el.scrollHeight > el.clientHeight + 1
}

function isScrollableX(el: HTMLElement): boolean {
  if (el === document.documentElement || el === document.body) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return false
  if (wantsNoScrollbar(el)) return false

  const ox = getOverflow(el).x
  if (ox !== 'auto' && ox !== 'scroll' && ox !== 'overlay') return false
  return el.scrollWidth > el.clientWidth + 1
}

function isScrollable(el: HTMLElement): boolean {
  return isScrollableY(el) || isScrollableX(el)
}

// ── 单轴 thumb 管理 ────────────────────────────────────

interface AxisThumb {
  thumb: HTMLDivElement
  /**
   * 必须用函数而不是布尔快照。
   *
   * 之前这里返回的是 `dragging` 的值拷贝，恒为 `false`；调用方（fadeEntry）
   * 用 `!e.v.dragging` 判断，于是**拖拽中照样把 thumb 淡出**
   * （`os-visible` 被摘掉 → opacity:0 + pointer-events:none），
   * 用户看到的正是「抓住了滑块，然后它自己没了」。
   */
  isDragging: () => boolean
  fadeTimer: ReturnType<typeof setTimeout> | null
  onThumbDown: (e: PointerEvent) => void
  onThumbEnter: () => void
  onThumbLeave: () => void
  update: () => void
  reveal: () => void
  scheduleFade: () => void
  destroy: () => void
}

/** 一次拖拽会话的固定参照，拖动过程中不再重算，避免边拖边抖 */
interface DragSession {
  pointerId: number
  /** 起始指针坐标（按轴取 clientY / clientX） */
  startPos: number
  /** 起始滚动位置 */
  startScroll: number
  /** 滑块可走的最大像素距离（track - thumbSize）；<= 0 表示没有行程 */
  travel: number
}

function createAxisThumb(axis: 'v' | 'h', vp: HTMLElement, parent: HTMLElement): AxisThumb {
  const thumb = document.createElement('div')
  thumb.className = axis === 'v' ? 'os-thumb' : 'os-thumb os-thumb-x'
  parent.appendChild(thumb)

  let fadeTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前拖拽会话；null 表示没在拖 */
  let drag: DragSession | null = null
  /** 拖拽期间挂在 document/window 上的监听清理器 */
  let dragCleanup: (() => void) | null = null

  const isDragging = () => drag !== null

  const scheduleFade = () => {
    if (fadeTimer) clearTimeout(fadeTimer)
    fadeTimer = setTimeout(() => {
      fadeTimer = null
      // 拖拽中绝不能淡出：一旦 os-visible 被摘掉，thumb 立刻 opacity:0 +
      // pointer-events:none，手感就是「抓住滑块，然后它自己消失了」。
      if (isDragging()) return
      thumb.classList.remove('os-visible')
    }, FADE_MS)
  }

  const reveal = () => {
    const overflow = axis === 'v' ? vp.scrollHeight > vp.clientHeight + 1 : vp.scrollWidth > vp.clientWidth + 1
    if (overflow) {
      thumb.classList.add('os-visible')
      scheduleFade()
    }
  }

  /** 滑块行程（track - thumbSize）。只在拖拽开始时取一次，拖拽期间不重算。 */
  const axisMetrics = () => {
    const vpRect = vp.getBoundingClientRect()
    const track = (axis === 'v' ? vpRect.height : vpRect.width) - TRACK_PAD * 2
    const thumbSize = axis === 'v' ? thumb.offsetHeight : thumb.offsetWidth
    return { travel: Math.max(0, track - thumbSize) }
  }

  let updateRaf: number | null = null
  const updateNow = () => {
    const vpRect = vp.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()

    if (axis === 'v') {
      const { scrollTop, scrollHeight, clientHeight } = vp
      if (scrollHeight <= clientHeight + 1) {
        thumb.classList.remove('os-visible')
        return
      }

      const track = vpRect.height - TRACK_PAD * 2
      let h = (clientHeight / scrollHeight) * track
      // 先保证可抓取的最小尺寸，再夹到轨道内：否则极小容器里 thumb 会比
      // 轨道还高，拖拽行程 travel 变 0，表现为「按住滑块但完全拖不动」。
      h = Math.min(Math.max(h, MIN_THUMB), Math.max(track, 0))

      const maxScroll = scrollHeight - clientHeight
      const maxTop = track - h
      const isReverse = scrollTop < 0 || getComputedStyle(vp).flexDirection === 'column-reverse'
      const ratio = isReverse ? (maxScroll + scrollTop) / maxScroll : scrollTop / maxScroll
      const thumbY = TRACK_PAD + (maxScroll > 0 ? ratio * maxTop : 0)

      thumb.style.height = `${h}px`
      thumb.style.top = `${vpRect.top - parentRect.top + thumbY}px`
      thumb.style.right = `${parentRect.right - vpRect.right}px`
    } else {
      const { scrollLeft, scrollWidth, clientWidth } = vp
      if (scrollWidth <= clientWidth + 1) {
        thumb.classList.remove('os-visible')
        return
      }

      const track = vpRect.width - TRACK_PAD * 2
      let w = (clientWidth / scrollWidth) * track
      w = Math.min(Math.max(w, MIN_THUMB), Math.max(track, 0))

      const maxScroll = scrollWidth - clientWidth
      const maxLeft = track - w
      const isRTL = getComputedStyle(vp).direction === 'rtl'
      const ratio = isRTL ? (maxScroll + scrollLeft) / maxScroll : scrollLeft / maxScroll
      const thumbX = TRACK_PAD + (maxScroll > 0 ? ratio * maxLeft : 0)

      thumb.style.width = `${w}px`
      thumb.style.left = `${vpRect.left - parentRect.left + thumbX}px`
      thumb.style.bottom = `${parentRect.bottom - vpRect.bottom}px`
    }
  }
  // 同帧多次 scroll/resize 合并为一次布局读，避免流式贴底时连环 getBoundingClientRect
  const update = () => {
    if (updateRaf !== null) return
    updateRaf = requestAnimationFrame(() => {
      updateRaf = null
      updateNow()
    })
  }

  // ── 拖拽 ──
  //
  // 旧实现的三个致命问题（侧栏项目多 / diff 卡片偶发「滑块卡住」的根因）：
  //
  // 1. pointermove / pointerup 只挂在 thumb 自己身上，且只监听 pointerup。
  //    触屏被浏览器手势接管 → pointercancel；thumb 被 reconcile/detach 重建 →
  //    指针捕获随节点消失。这两种情况都收不到 pointerup，于是 dragging 永久为
  //    true、onMove 永久留在 DOM 上，后续移动继续带着旧的 startScroll 改
  //    scrollTop，表现就是「滑块卡在那里 / 一抖一抖」。
  // 2. onUp 里 releasePointerCapture 无保护，捕获已丢时会抛 DOMException，
  //    后面「复位 dragging + 摘监听」全被跳过（相当于 1 的必然触发路径）。
  // 3. 换算用 clientHeight - thumb.offsetHeight，而滑块实际行程是
  //    track - thumbHeight（差 2×TRACK_PAD），长列表拖到底会偏。
  const endDrag = () => {
    const current = drag
    if (!current) return
    drag = null
    thumb.classList.remove('os-dragging')
    dragCleanup?.()
    dragCleanup = null
    // 捕获可能已经没了：先探测再释放，并吞掉异常，保证后续清理一定执行
    if (thumb.hasPointerCapture?.(current.pointerId)) {
      try {
        thumb.releasePointerCapture(current.pointerId)
      } catch {
        // 部分 WebView 在节点已脱离文档时仍会抛，忽略即可
      }
    }
    scheduleFade()
  }

  const applyDrag = (ev: PointerEvent) => {
    const current = drag
    if (!current || current.travel <= 0) return
    const pos = axis === 'v' ? ev.clientY : ev.clientX
    // 行程用按下时的实测值（拖拽中 thumb 尺寸变化会让手感抖），
    // 可滚动距离按当前值取：侧栏在拖拽中懒加载出更多内容时，
    // 仍能拖到真正的底部。
    const maxScroll = axis === 'v' ? vp.scrollHeight - vp.clientHeight : vp.scrollWidth - vp.clientWidth
    if (maxScroll <= 0) return
    const delta = ((pos - current.startPos) / current.travel) * maxScroll
    const next = current.startScroll + delta
    if (axis === 'v') {
      if (Math.abs(vp.scrollTop - next) >= 0.5) vp.scrollTop = next
    } else if (Math.abs(vp.scrollLeft - next) >= 0.5) {
      vp.scrollLeft = next
    }
  }

  const onThumbDown = (e: PointerEvent) => {
    // 已经在拖（多指 / 重复按下）：忽略，避免两套会话互相覆盖
    if (drag) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    // 拖拽前把几何刷到最新：thumb 尺寸由 updateNow 写入，行程要按实测值算
    updateNow()

    const { travel } = axisMetrics()
    drag = {
      pointerId: e.pointerId,
      startPos: axis === 'v' ? e.clientY : e.clientX,
      startScroll: axis === 'v' ? vp.scrollTop : vp.scrollLeft,
      travel,
    }
    thumb.classList.add('os-dragging')
    thumb.classList.add('os-visible')
    if (fadeTimer) {
      clearTimeout(fadeTimer)
      fadeTimer = null
    }

    try {
      thumb.setPointerCapture?.(e.pointerId)
    } catch {
      // 不支持捕获的环境（部分 WebView）退化为 document 监听，下面已覆盖
    }

    // 收尾必须挂在 document 上：指针移出 thumb、捕获丢失、被手势接管时
    // thumb 自身收不到事件。三种终止信号都要处理，否则 dragging 会悬空。
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== drag?.pointerId) return
      applyDrag(ev)
    }
    const onFinish = (ev: PointerEvent) => {
      if (ev.pointerId !== drag?.pointerId) return
      endDrag()
    }
    /** 捕获被夺走（节点被移出文档 / 其他元素抢走）→ 立刻结束本次拖拽 */
    const onLostCapture = (ev: PointerEvent) => {
      if (ev.pointerId !== drag?.pointerId) return
      endDrag()
    }
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endDrag()
    }
    const onWindowBlur = () => endDrag()

    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onFinish, true)
    document.addEventListener('pointercancel', onFinish, true)
    window.addEventListener('blur', onWindowBlur, true)
    window.addEventListener('keydown', onKeyDown, true)
    thumb.addEventListener('lostpointercapture', onLostCapture)

    dragCleanup = () => {
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onFinish, true)
      document.removeEventListener('pointercancel', onFinish, true)
      window.removeEventListener('blur', onWindowBlur, true)
      window.removeEventListener('keydown', onKeyDown, true)
      thumb.removeEventListener('lostpointercapture', onLostCapture)
    }
  }

  // thumb 自身 hover：防止从容器移向 thumb 时消失
  const onThumbEnter = () => {
    if (fadeTimer) {
      clearTimeout(fadeTimer)
      fadeTimer = null
    }
  }
  const onThumbLeave = () => {
    if (!isDragging()) scheduleFade()
  }

  thumb.addEventListener('pointerdown', onThumbDown)
  thumb.addEventListener('pointerenter', onThumbEnter)
  thumb.addEventListener('pointerleave', onThumbLeave)

  const destroy = () => {
    // 拖拽中被销毁（reconcile 换方向 / 容器被摘除）：先把会话结束掉，
    // 否则 document 上的监听器会永久残留。
    endDrag()
    thumb.removeEventListener('pointerdown', onThumbDown)
    thumb.removeEventListener('pointerenter', onThumbEnter)
    thumb.removeEventListener('pointerleave', onThumbLeave)
    if (updateRaf !== null) cancelAnimationFrame(updateRaf)
    updateRaf = null
    if (fadeTimer) {
      clearTimeout(fadeTimer)
      fadeTimer = null
    }
    thumb.remove()
  }

  return {
    thumb,
    isDragging,
    fadeTimer,
    onThumbDown,
    onThumbEnter,
    onThumbLeave,
    update,
    reveal,
    scheduleFade,
    destroy,
  }
}

// ── Entry ───────────────────────────────────────────────

interface Entry {
  vp: HTMLElement
  parent: HTMLElement
  v: AxisThumb | null
  h: AxisThumb | null
  ro: ResizeObserver
  onScroll: () => void
  onEnter: () => void
  onLeave: () => void
  /** 需要复查方向（尺寸/样式变化后）。稳定 entry 不再每批 mutation 都 getComputedStyle */
  dirty: boolean
}
let entries = new Map<HTMLElement, Entry>()

/** 标记某容器需要复查方向 */
function markDirty(el: HTMLElement) {
  const entry = entries.get(el)
  if (entry) entry.dirty = true
}

/** 从节点沿祖先链标记已跟踪的滚动容器脏（内容变化会影响 scrollHeight/clientHeight） */
function markTrackedAncestorsDirty(el: HTMLElement) {
  let cur: HTMLElement | null = el
  while (cur && cur !== document.documentElement) {
    if (entries.has(cur)) {
      markDirty(cur)
      return
    }
    cur = cur.parentElement
  }
}

function ensurePositioned(parent: HTMLElement) {
  const pos = getComputedStyle(parent).position
  if (pos === 'static' || pos === '') parent.style.position = 'relative'
}

function attach(vp: HTMLElement) {
  if (entries.has(vp)) return
  const parent = vp.parentElement
  if (!parent) return

  ensurePositioned(parent)

  const needsY = isScrollableY(vp)
  const needsX = isScrollableX(vp)
  const v = needsY ? createAxisThumb('v', vp, parent) : null
  const h = needsX ? createAxisThumb('h', vp, parent) : null

  vp.setAttribute(ATTR, '')

  const update = () => {
    v?.update()
    h?.update()
  }

  const onScroll = () => {
    update()
    v?.reveal()
    h?.reveal()
  }

  /** 显示自身 + 内部后代 entry 的所有 thumb */
  const revealEntry = (e: Entry) => {
    if (e.v && e.vp.scrollHeight > e.vp.clientHeight + 1) {
      e.v.update()
      e.v.thumb.classList.add('os-visible')
      if (e.v.fadeTimer) clearTimeout(e.v.fadeTimer)
    }
    if (e.h && e.vp.scrollWidth > e.vp.clientWidth + 1) {
      e.h.update()
      e.h.thumb.classList.add('os-visible')
      if (e.h.fadeTimer) clearTimeout(e.h.fadeTimer)
    }
  }

  const fadeEntry = (e: Entry) => {
    if (e.v && !e.v.isDragging()) {
      if (e.v.fadeTimer) clearTimeout(e.v.fadeTimer)
      e.v.fadeTimer = setTimeout(() => {
        if (!e.v?.isDragging()) e.v?.thumb.classList.remove('os-visible')
      }, 400)
    }
    if (e.h && !e.h.isDragging()) {
      if (e.h.fadeTimer) clearTimeout(e.h.fadeTimer)
      e.h.fadeTimer = setTimeout(() => {
        if (!e.h?.isDragging()) e.h?.thumb.classList.remove('os-visible')
      }, 400)
    }
  }

  const onEnter = () => {
    // 显示自身 + 内部后代 entry 的所有 thumb
    for (const e of entries.values()) {
      if (e.vp === vp || vp.contains(e.vp)) revealEntry(e)
    }
  }

  const onLeave = () => {
    for (const e of entries.values()) {
      if (e.vp === vp || vp.contains(e.vp)) fadeEntry(e)
    }
  }

  vp.addEventListener('scroll', onScroll, { passive: true })
  vp.addEventListener('pointerenter', onEnter)
  vp.addEventListener('pointerleave', onLeave)

  const ro = new ResizeObserver(() => {
    // 尺寸变化可能改变滚动方向需求：标记脏，由下一批 reconcile 复查
    markDirty(vp)
    update()
  })
  ro.observe(vp)
  update()

  const entry: Entry = { vp, parent, v, h, ro, onScroll, onEnter, onLeave, dirty: false }
  entries.set(vp, entry)
}

// ── 卸载 ────────────────────────────────────────────────

function detach(vp: HTMLElement) {
  const e = entries.get(vp)
  if (!e) return

  vp.removeEventListener('scroll', e.onScroll)
  vp.removeEventListener('pointerenter', e.onEnter)
  vp.removeEventListener('pointerleave', e.onLeave)
  e.v?.destroy()
  e.h?.destroy()
  e.ro.disconnect()
  vp.removeAttribute(ATTR)
  entries.delete(vp)
}

// ── 方向变化检测 ────────────────────────────────────────

function reconcile(vp: HTMLElement, entry: Entry) {
  // 拖拽进行中不改动 thumb：销毁会连带丢掉指针捕获与 document 监听，
  // 抬手事件永久收不到，滑块就"卡死"了。等拖拽结束后的下一批 mutation 再复查。
  if (entry.v?.isDragging() || entry.h?.isDragging()) return

  const needsY = isScrollableY(vp)
  const needsX = isScrollableX(vp)
  const hasY = !!entry.v
  const hasX = !!entry.h

  if (needsY && !hasY) {
    ensurePositioned(entry.parent)
    entry.v = createAxisThumb('v', vp, entry.parent)
  } else if (!needsY && hasY) {
    entry.v!.destroy()
    entry.v = null
  }

  if (needsX && !hasX) {
    ensurePositioned(entry.parent)
    entry.h = createAxisThumb('h', vp, entry.parent)
  } else if (!needsX && hasX) {
    entry.h!.destroy()
    entry.h = null
  }
}
// ── 扫描 DOM ────────────────────────────────────────────

function tryAttach(el: HTMLElement) {
  if (entries.has(el) || el.hasAttribute(ATTR) || el.classList.contains('os-thumb') || !isScrollable(el)) {
    return
  }
  attach(el)
}

/** 在 root 子树内查找可滚动容器并 attach（root 自身也会检查） */
function scanTree(root: HTMLElement) {
  tryAttach(root)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.nextNode()
  while (node) {
    tryAttach(node as HTMLElement)
    node = walker.nextNode()
  }
}

/** 核对已有 entry：不在 DOM 的直接移除并 detach；方向只对「可能变化」的 entry 复查 */
function reconcileAll() {
  for (const [vp, entry] of entries) {
    // document.contains 是廉价的原生检查；已从 DOM 摘除的 entry 直接清理，
    // 不再对其调用 isScrollable（避免无意义的 getComputedStyle）
    if (!document.contains(vp)) {
      detach(vp)
      continue
    }
    if (entry.dirty) {
      entry.dirty = false
      reconcile(vp, entry)
    }
  }
}

function scan() {
  reconcileAll()
  if (document.body) scanTree(document.body)
}

/** 祖先链也可能因内容尺寸变化变成可滚动，沿 parent 向上补 attach */
function tryAttachAncestors(el: HTMLElement) {
  let cur: HTMLElement | null = el
  while (cur && cur !== document.documentElement) {
    if (cur.classList.contains('os-thumb')) {
      cur = cur.parentElement
      continue
    }
    tryAttach(cur)
    cur = cur.parentElement
  }
}

/** 该节点或其祖先链上是否存在已跟踪的滚动容器（用于过滤无关 mutation） */
function isNearTrackedContainer(node: HTMLElement): boolean {
  let cur: HTMLElement | null = node
  while (cur && cur !== document.documentElement) {
    if (entries.has(cur)) return true
    cur = cur.parentElement
  }
  return false
}

/**
 * 增量扫描：只处理 mutation 触及的节点及其子树，避免流式 DOM 更新时
 * 每次都 TreeWalker 整页 + getComputedStyle。
 */
function scanMutations(mutations: MutationRecord[]) {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      // 子节点增减可能让 mutation.target 自身变成可滚动，也可能改变祖先容器的
      // scrollHeight/clientHeight → 标记最近的已跟踪祖先脏，下一批复查方向
      if (mutation.target instanceof HTMLElement) {
        markTrackedAncestorsDirty(mutation.target)
        tryAttachAncestors(mutation.target)
      }
      mutation.addedNodes.forEach(node => {
        if (node instanceof HTMLElement) scanTree(node)
      })
      continue
    }

    if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
      const el = mutation.target
      if (el.classList.contains('os-thumb')) continue
      // class/style 变了：overflow 缓存作废，自身与祖先都可能新变成可滚动。
      // 与已跟踪容器无关的子树（如流式正文里的行内 class）直接跳过全量祖先遍历
      overflowCache.delete(el)
      if (!isNearTrackedContainer(el)) continue
      markDirty(el)
      tryAttachAncestors(el)
    }
  }
}

// ── 初始化 ──────────────────────────────────────────────

let inited = false

export function initOverlayScrollbars() {
  if (inited) return
  inited = true
  // 清掉流式/DOM 变更期间可能被（主动）移除的节点残留的 overflow 缓存
  overflowCache = new WeakMap()

  scan()

  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingMutations: MutationRecord[] = []

  const flushScan = () => {
    timer = null
    const batch = pendingMutations
    pendingMutations = []
    // 先核对已有 entry：已从 DOM 摘除的容器必须 detach，否则其 vp（整棵消息
    // DOM）会经 entries 这个模块级 Map 永久驻留。此前只在「空批次」分支经
    // scan() 走到这一步，流式期间 mutation 不断、永远走 scanMutations，
    // 导致每次会话 remount 的旧滚动容器都泄漏（实测累积 131 个）。
    reconcileAll()
    if (batch.length === 0) {
      if (document.body) scanTree(document.body)
      return
    }
    scanMutations(batch)
  }

  const debounceScan = (mutations?: MutationRecord[]) => {
    if (mutations) pendingMutations.push(...mutations)
    if (timer) return
    timer = setTimeout(flushScan, 200)
  }

  const observer = new MutationObserver(mutations => debounceScan(mutations))
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  })

  // resize 时布局全变，走全量 scan
  const onResize = () => debounceScan()
  window.addEventListener('resize', onResize, { passive: true })

  const disposableEntries = entries
  const disposableOverflowCache = overflowCache

  teardown = () => {
    observer.disconnect()
    window.removeEventListener('resize', onResize)
    if (timer) clearTimeout(timer)
    timer = null
    pendingMutations = []
    // 清掉所有 entry 的 thumb / scroll 与 pointer 监听 / ResizeObserver / rAF，
    // 允许重新 init（测试 / HMR）
    for (const vp of Array.from(disposableEntries.keys())) detach(vp)
    disposableEntries.clear()
    // 仅在未被后续 init 替换时复位共享集合，避免误清新一代状态
    if (entries === disposableEntries) entries = new Map()
    if (overflowCache === disposableOverflowCache) overflowCache = new WeakMap()
    inited = false
    teardown = null
  }

  // 每个 entry 已有 scroll 监听更新自身 thumb。
  // 祖先滚动时，子 vp 与其 parent 同位移，相对定位不变，无需全量刷新所有 entry。
}

let teardown: (() => void) | null = null

/**
 * 停止全局滚动条注入并清理所有资源：
 * MutationObserver / window resize 监听 / 定时器 / 每个容器的
 * scroll+pointer 监听 / ResizeObserver / 挂起的 rAF / thumb DOM。
 * 调用后可再次 init（测试 / HMR）。
 */
export function disposeOverlayScrollbars() {
  teardown?.()
}
