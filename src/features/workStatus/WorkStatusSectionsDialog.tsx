// ============================================
// WorkStatusSectionsDialog — 「面板板块」配置弹窗
// ============================================
//
// 每行：拖拽手柄 + 勾选框 + 名称。
// 顺序与显隐共用同一套稳定 id；隐藏的板块保留数据，只是不再显示。

import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { GripVerticalIcon } from '../../components/Icons'
import { cn } from '../../utils/cn'
import { workStatusStore, useWorkStatus } from '../../store/workStatusStore'
import {
  areAllWorkStatusSectionsHidden,
  isWorkStatusSectionVisible,
  sanitizeWorkStatusSectionOrder,
  type WorkStatusSectionId,
} from './sections'

interface WorkStatusSectionsDialogProps {
  isOpen: boolean
  onClose: () => void
}

export const WorkStatusSectionsDialog = memo(function WorkStatusSectionsDialog({
  isOpen,
  onClose,
}: WorkStatusSectionsDialogProps) {
  const { t } = useTranslation(['chat', 'common'])
  const state = useWorkStatus()
  const [dragId, setDragId] = useState<WorkStatusSectionId | null>(null)
  const [overId, setOverId] = useState<WorkStatusSectionId | null>(null)
  const dragIdRef = useRef<WorkStatusSectionId | null>(null)

  const sectionOrder = useMemo(() => sanitizeWorkStatusSectionOrder(state.order), [state.order])

  const handleDrop = useCallback(
    (targetId: WorkStatusSectionId) => {
      const sourceId = dragIdRef.current
      dragIdRef.current = null
      setDragId(null)
      setOverId(null)
      if (!sourceId || sourceId === targetId) return

      const from = sectionOrder.indexOf(sourceId)
      const to = sectionOrder.indexOf(targetId)
      if (from === -1 || to === -1) return
      const next = [...sectionOrder]
      next.splice(from, 1)
      next.splice(to, 0, sourceId)
      workStatusStore.setSectionOrder(next)
    },
    [sectionOrder],
  )

  const allVisible = state.hidden.length === 0
  const noneVisible = areAllWorkStatusSectionsHidden(state.hidden)

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('chat:workStatus.sections.dialogTitle')} width={420}>
      <p className="mb-3 text-ui-caption text-text-400">
        {t('chat:workStatus.sections.dialogDescription')}
      </p>

      <ul className="flex flex-col gap-0.5">
        {sectionOrder.map(id => {
          const checked = isWorkStatusSectionVisible(state.hidden, id)
          const label = t(`chat:workStatus.section.${id}`)
          const isDragging = dragId === id
          const isOver = overId === id && dragId !== id
          return (
            <li
              key={id}
              onDragOver={event => {
                if (!dragIdRef.current || dragIdRef.current === id) return
                event.preventDefault()
                setOverId(id)
              }}
              onDragLeave={() => setOverId(prev => (prev === id ? null : prev))}
              onDrop={event => {
                event.preventDefault()
                handleDrop(id)
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-1.5 py-1.5',
                isDragging && 'opacity-40',
                isOver && 'bg-accent-main-100/10',
              )}
            >
              <span
                draggable
                onDragStart={event => {
                  dragIdRef.current = id
                  setDragId(id)
                  event.dataTransfer.effectAllowed = 'move'
                  // Firefox 需要 setData 才会真正开始拖拽
                  event.dataTransfer.setData('text/plain', id)
                }}
                onDragEnd={() => {
                  dragIdRef.current = null
                  setDragId(null)
                  setOverId(null)
                }}
                aria-label={t('chat:workStatus.sections.reorder', { label })}
                className="inline-flex cursor-grab items-center justify-center text-text-500 active:cursor-grabbing"
              >
                <GripVerticalIcon size={14} />
              </span>

              <Checkbox
                checked={checked}
                onCheckedChange={next => workStatusStore.setSectionVisible(id, next === true)}
                aria-label={label}
              />

              <span className="min-w-0 flex-1 truncate text-ui-base text-text-200">{label}</span>
            </li>
          )
        })}
      </ul>

      {!allVisible ? (
        <div className="mt-3 flex items-center justify-between border-t border-border-200/50 pt-3">
          {noneVisible ? (
            <span className="text-ui-sm text-danger-100">
              {t('chat:workStatus.sections.noneWarning')}
            </span>
          ) : (
            <span />
          )}
          <Button variant="ghost" size="sm" onClick={() => workStatusStore.setHiddenSections([])}>
            {t('chat:workStatus.sections.showAll')}
          </Button>
        </div>
      ) : null}
    </Dialog>
  )
})
