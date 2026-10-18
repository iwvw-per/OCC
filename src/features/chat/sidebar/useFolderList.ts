// ============================================
// 侧栏列表的小工具与 hook
//
// 从 FolderRecentList.tsx 抽出：项目展开状态的派生辅助、拖拽期临时收起、
// 以及「长按/拖动排序」的通用 hook。
// ============================================

import { useCallback, useRef, useState } from 'react'

export function areProjectIdListsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/**
 * 只做「剔除已不存在的项目」。
 *
 * 刻意不加「空列表时展开第一个」的兜底：展开状态是跨端同步的，用户把项目全部
 * 收起后 prev 就是空数组，兜底会把它重新展开并写回存储 —— 收起操作永远失效，
 * 且会覆盖其它设备的展开状态。首次进入的默认展开由调用方一次性处理。
 */
export function reconcileExpandedProjectIds(prev: string[], projects: ReadonlyArray<{ id: string }>) {
  const next = prev.filter(id => projects.some(project => project.id === id))
  return areProjectIdListsEqual(next, prev) ? prev : next
}

export function toggleProjectId(prev: string[], projectId: string) {
  return prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]
}

/**
 * 拖拽排序期间临时收起所有项目（列表变短，便于看到全部目标位），
 * 拖拽结束后恢复原展开状态。
 */
export function useCollapseExpandedIdsOnDrag(
  expandedIds: string[],
  setExpandedIds: (updater: (prev: string[]) => string[]) => void,
) {
  const savedExpandedRef = useRef<string[] | null>(null)

  const handleDragActivated = useCallback(() => {
    savedExpandedRef.current = expandedIds
    setExpandedIds(() => [])
  }, [expandedIds, setExpandedIds])

  const handleDragFinished = useCallback(() => {
    if (!savedExpandedRef.current) return
    const saved = savedExpandedRef.current
    savedExpandedRef.current = null
    setExpandedIds(() => saved)
  }, [setExpandedIds])

  return { handleDragActivated, handleDragFinished }
}

export interface ReorderState {
  draggedId: string
  currentOrder: string[]
}

export interface UseReorderableListOptions {
  ids: string[]
  canDrag: (id: string) => boolean
  onCommit: (draggedId: string, targetId: string) => void
  onDragActivated?: () => void
  onDragFinished?: () => void
}

export interface ReorderableListApi {
  dragState: ReorderState | null
  registerRef: (id: string, element: HTMLDivElement | null) => void
  handlePointerDown: (id: string, event: React.PointerEvent) => void
  handleTouchStart: (id: string, event: React.TouchEvent) => void
  handleTouchMove: (event: React.TouchEvent) => void
  handleTouchEnd: () => void
}

export function useReorderableList({
  ids,
  canDrag,
  onCommit,
  onDragActivated,
  onDragFinished,
}: UseReorderableListOptions): ReorderableListApi {
  const refs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [dragState, setDragState] = useState<ReorderState | null>(null)
  const dragStartY = useRef(0)
  const dragActive = useRef(false)
  const latestOrderRef = useRef<string[]>([])
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchMovedRef = useRef(false)
  const touchStartYRef = useRef(0)

  const registerRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) refs.current.set(id, element)
    else refs.current.delete(id)
  }, [])

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const finish = useCallback(() => {
    clearLongPress()
    if (dragActive.current) {
      onDragFinished?.()
      dragActive.current = false
    }
    setDragState(null)
  }, [clearLongPress, onDragFinished])

  const begin = useCallback(
    (id: string) => {
      if (!canDrag(id)) return
      dragActive.current = true
      latestOrderRef.current = ids
      onDragActivated?.()
      setDragState({ draggedId: id, currentOrder: ids })
    },
    [canDrag, ids, onDragActivated],
  )

  const updateOrderByY = useCallback((clientY: number) => {
    const dragged = latestOrderRef.current
    if (dragged.length === 0) return
    // 以各行的中线为界：指针越过后面的行中点就与它交换
    const entries = dragged.map(id => ({ id, element: refs.current.get(id) }))
    const target = entries.find(entry => {
      const rect = entry.element?.getBoundingClientRect()
      return rect ? clientY < rect.top + rect.height / 2 : false
    })
    const targetId = target?.id
    if (!targetId) return
    const from = dragged.indexOf(dragState?.draggedId ?? '')
    const to = dragged.indexOf(targetId)
    if (from === -1 || to === -1 || from === to) return
    const next = [...dragged]
    next.splice(to, 0, ...next.splice(from, 1))
    latestOrderRef.current = next
    setDragState(prev => (prev ? { ...prev, currentOrder: next } : prev))
  }, [dragState?.draggedId])

  const handlePointerDown = useCallback(
    (id: string, event: React.PointerEvent) => {
      if (event.button !== 0) return
      dragStartY.current = event.clientY
      begin(id)
    },
    [begin],
  )

  const handleTouchStart = useCallback(
    (id: string, event: React.TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      touchMovedRef.current = false
      touchStartYRef.current = touch.clientY
      clearLongPress()
      // 长按 350ms 才进入拖动，避免与滚动冲突
      longPressTimer.current = setTimeout(() => begin(id), 350)
    },
    [begin, clearLongPress],
  )

  const handleTouchMove = useCallback(
    (event: React.TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      if (!dragActive.current) {
        if (Math.abs(touch.clientY - touchStartYRef.current) > 8) {
          touchMovedRef.current = true
          clearLongPress()
        }
        return
      }
      updateOrderByY(touch.clientY)
    },
    [clearLongPress, updateOrderByY],
  )

  const handleTouchEnd = useCallback(() => {
    clearLongPress()
    if (!dragActive.current) return
    const order = latestOrderRef.current
    const draggedId = dragState?.draggedId
    const targetId = order.find(id => id !== draggedId)
    if (draggedId && targetId) onCommit(draggedId, targetId)
    finish()
  }, [clearLongPress, dragState?.draggedId, finish, onCommit])

  return {
    dragState,
    registerRef,
    handlePointerDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  }
}
