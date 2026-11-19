import {
  memo,
  useCallback,
  useEffect,
  useState,
  useRef,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { CloseIcon } from './Icons'
import { cn } from '../utils/cn'
import { interactive } from '../utils/interaction'
import { getMaterialIconUrl } from '../utils/materialIcons'
import {
  getInternalDragSnapshot,
  startInternalDrag,
  subscribeInternalDrag,
  subscribeInternalDrop,
} from '../lib/internalDragCore'
import { useDragEdgeAutoScroll } from '../hooks/useDragEdgeAutoScroll'
import { NativeTooltip } from './ui/Tooltip'

export interface PreviewTabsBarItem {
  id: string
  title: string
  closeTitle: string
  iconPath?: string
  label: ReactNode
}

interface PreviewTabsBarProps {
  items: PreviewTabsBarItem[]
  activeId: string | null
  closeAllTitle: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseAll: () => void
  onReorder: (draggedId: string, targetId: string) => void
  rightActions?: ReactNode
  tabWidthClassName?: string
}

export const PreviewTabsBar = memo(function PreviewTabsBar({
  items,
  activeId,
  closeAllTitle,
  onActivate,
  onClose,
  onCloseAll,
  onReorder,
  rightActions,
  tabWidthClassName = 'w-40 max-w-40',
}: PreviewTabsBarProps) {
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  useDragEdgeAutoScroll(tabsScrollRef, {
    payloadKind: 'preview-tab',
  })

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'preview-tab') {
        setDraggedId(null)
        setDragOverId(null)
        return
      }

      setDraggedId(active.payload.id)
      const target = document
        .elementFromPoint(active.current.x, active.current.y)
        ?.closest<HTMLElement>('[data-preview-tab-id]')
      const targetId = target?.dataset.previewTabId
      setDragOverId(targetId && targetId !== active.payload.id ? targetId : null)
    })
  }, [])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'preview-tab') return
      const target = document
        .elementFromPoint(event.point.x, event.point.y)
        ?.closest<HTMLElement>('[data-preview-tab-id]')
      const targetId = target?.dataset.previewTabId
      if (targetId && targetId !== event.payload.id) {
        onReorder(event.payload.id, targetId)
      }
      setDraggedId(null)
      setDragOverId(null)
    })
  }, [onReorder])

  const handleTabsWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const container = tabsScrollRef.current
    if (!container || container.scrollWidth <= container.clientWidth) return

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return

    event.preventDefault()
    container.scrollLeft += delta
  }, [])

  return (
    <div className="relative flex items-center justify-between shrink-0 bg-bg-200/60 h-[30px]">
      <div
        ref={tabsScrollRef}
        onWheel={handleTabsWheel}
        className="min-w-0 flex-1 h-full overflow-x-auto overflow-y-hidden no-scrollbar"
      >
        <div className="flex min-w-max items-center h-full gap-0">
          {items.map(item => {
            const isActive = item.id === activeId
            const isDragOver = dragOverId === item.id && draggedId !== item.id

            return (
              <div
                key={item.id}
                data-preview-tab-id={item.id}
                onPointerDown={event => {
                  const target = event.target as HTMLElement
                  if (target.closest('button')) return
                  startInternalDrag(event, { kind: 'preview-tab', id: item.id })
                }}
                onMouseDown={event => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  event.stopPropagation()
                  onClose(item.id)
                }}
                className={cn(
                  'relative mx-px flex shrink-0 select-none items-center gap-1',
                  tabWidthClassName,
                  isActive
                    ? // 激活标签：实底 + 主文字色，与浏览器标签一致（肩部弧线由 .tab-active 提供）
                      'tab-active z-10 h-full bg-bg-100 text-text-100'
                    : cn(
                        'h-[24px] overflow-hidden rounded-md border-x-[5px] border-transparent bg-transparent text-text-400',
                        // 拖拽落点用浅 accent 底提示，与 hover 底色可区分
                        isDragOver ? 'bg-accent-main-100/8' : interactive.row,
                      ),
                )}
                title={item.title}
              >
                <button
                  type="button"
                  onClick={() => onActivate(item.id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden pl-2.5 pr-1 text-left"
                >
                  {item.iconPath && (
                    <img
                      src={getMaterialIconUrl(item.iconPath, 'file')}
                      alt=""
                      width={13}
                      height={13}
                      draggable={false}
                      className="shrink-0"
                      onError={e => {
                        e.currentTarget.style.visibility = 'hidden'
                      }}
                    />
                  )}
                  {item.label}
                </button>
                <NativeTooltip>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      onClose(item.id)
                    }}
                    className={cn(
                      'mr-1.5 shrink-0 rounded-sm p-1 text-text-500 hover:text-text-100',
                      interactive.subtle,
                    )}
                    title={item.closeTitle}
                    aria-label={item.closeTitle}
                  >
                    <CloseIcon size={10} />
                  </button>
                </NativeTooltip>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-0.5 shrink-0 px-1.5 h-full">
        {rightActions}
        <NativeTooltip>
          <button
            onClick={onCloseAll}
            className={cn('shrink-0 rounded-sm p-1 text-text-400 hover:text-text-100', interactive.subtle)}
            title={closeAllTitle}
            aria-label={closeAllTitle}
          >
            <CloseIcon size={12} />
          </button>
        </NativeTooltip>
      </div>
    </div>
  )
})
