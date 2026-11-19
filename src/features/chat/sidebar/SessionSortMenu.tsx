// ============================================
// SessionSortMenu — 侧栏「项目排序」菜单
// ============================================
//
// 会话列表固定「最新对话置顶」，不提供排序选项；本菜单只控制项目文件夹的
// 排序字段（最后对话时间 / 保存时间）与方向。
// 偏好存 layoutStore（localStorage 持久化），排序在 SidePanel 应用。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClockIcon, CalendarPlusIcon, SortIcon, SortDescIcon, CheckIcon } from '../../../components/Icons'
import { DropdownMenu, IconButton } from '../../../components/ui'
import { interactive } from '../../../utils/interaction'
import { useLayoutStore, layoutStore } from '../../../store'
import type { SessionSortField } from '../../../utils'

export function SessionSortMenu() {
  const { t } = useTranslation('chat')
  const { sidebarProjectSortField, sidebarProjectSortDesc } = useLayoutStore()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const apply = (field: SessionSortField, desc: boolean) => {
    layoutStore.setSidebarProjectSort(field, desc)
    setIsOpen(false)
  }

  // 点击外部关闭（DropdownMenu 是 portal，菜单节点在 trigger 之外，需要单独判断）
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen])

  const fields: Array<{ field: SessionSortField; label: string; icon: React.ReactNode }> = [
    { field: 'updated', label: t('sidebar.sortProjectsByUpdated', { defaultValue: '最后对话时间' }), icon: <ClockIcon size={14} /> },
    {
      field: 'created',
      label: t('sidebar.sortProjectsByCreated', { defaultValue: '项目添加时间' }),
      icon: <CalendarPlusIcon size={14} />,
    },
  ]

  return (
    <>
      <IconButton
        ref={triggerRef}
        size="sm"
        onMouseDown={e => e.preventDefault()}
        onClick={() => setIsOpen(open => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('sidebar.sortSessions', { defaultValue: '排序' })}
        className={isOpen ? interactive.toggleActiveNeutral : 'border border-transparent'}
        title={t('sidebar.sortSessions', { defaultValue: '排序' })}
      >
        {sidebarProjectSortDesc ? <SortDescIcon size={14} /> : <SortIcon size={14} />}
      </IconButton>

      <DropdownMenu
        triggerRef={triggerRef}
        isOpen={isOpen}
        position="bottom"
        align="right"
        minWidth="180px"
        maxWidth="min(240px, calc(100vw - 24px))"
      >
        <div ref={menuRef} role="menu" aria-label={t('sidebar.sortSessions', { defaultValue: '排序' })} className="p-1">
          <div className="px-2 pt-1 pb-1.5 text-ui-xs font-semibold uppercase tracking-wider text-text-400/60 select-none">
            {t('sidebar.sortBy', { defaultValue: '排序方式' })}
          </div>
          {/* 条目之间留 2px：item 是 rounded-lg + hover 底色，紧贴时相邻圆角会拼成一条凹槽。
             不用容器 gap，避免把分组标题和分隔线的间距也一起撑开。 */}
          <div className="flex flex-col gap-0.5">
            {fields.map(({ field, label, icon }) => (
              <button
                key={field}
                type="button"
                role="menuitemradio"
                aria-checked={sidebarProjectSortField === field}
                onClick={() => apply(field, sidebarProjectSortDesc)}
                className={`w-full px-2 py-2 rounded-lg flex items-center gap-2 text-left bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-bg-200 ${
                  sidebarProjectSortField === field ? 'text-text-100' : 'text-text-300'
                }`}
              >
                <span className="w-4 h-4 flex items-center justify-center shrink-0 text-text-400">{icon}</span>
                <span className="flex-1 min-w-0 truncate text-ui-caption">{label}</span>
                {sidebarProjectSortField === field && (
                  <span className="w-4 flex items-center justify-center shrink-0 text-accent-main-100">
                    <CheckIcon size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="mx-1 my-1 h-px bg-border-200/50" />

          <div className="px-2 pt-1 pb-1.5 text-ui-xs font-semibold uppercase tracking-wider text-text-400/60 select-none">
            {t('sidebar.sortDirection', { defaultValue: '方向' })}
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={sidebarProjectSortDesc}
            onClick={() => apply(sidebarProjectSortField, true)}
            className={`w-full px-2 py-2 rounded-lg flex items-center gap-2 text-left bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-bg-200 ${
              sidebarProjectSortDesc ? 'text-text-100' : 'text-text-300'
            }`}
          >
            <span className="w-4 h-4 flex items-center justify-center shrink-0 text-text-400">
              <SortDescIcon size={14} />
            </span>
            <span className="flex-1 min-w-0 truncate text-ui-caption">
              {t('sidebar.sortDesc', { defaultValue: '倒序（新 → 旧）' })}
            </span>
            {sidebarProjectSortDesc && (
              <span className="w-4 flex items-center justify-center shrink-0 text-accent-main-100">
                <CheckIcon size={14} />
              </span>
            )}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!sidebarProjectSortDesc}
            onClick={() => apply(sidebarProjectSortField, false)}
            className={`w-full px-2 py-2 rounded-lg flex items-center gap-2 text-left bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-bg-200 ${
              !sidebarProjectSortDesc ? 'text-text-100' : 'text-text-300'
            }`}
          >
            <span className="w-4 h-4 flex items-center justify-center shrink-0 text-text-400">
              <SortIcon size={14} />
            </span>
            <span className="flex-1 min-w-0 truncate text-ui-caption">
              {t('sidebar.sortAsc', { defaultValue: '正序（旧 → 新）' })}
            </span>
            {!sidebarProjectSortDesc && (
              <span className="w-4 flex items-center justify-center shrink-0 text-accent-main-100">
                <CheckIcon size={14} />
              </span>
            )}
          </button>
        </div>
      </DropdownMenu>
    </>
  )
}
