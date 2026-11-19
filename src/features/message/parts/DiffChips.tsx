import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverAnchor, PopoverContent } from '../../../components/ui/Popover'
import { NativeTooltip } from '../../../components/ui/Tooltip'
import { getMaterialIconUrl } from '../../../utils/materialIcons'
import { cn } from '../../../utils/cn'
import { layoutStore } from '../../../store/layoutStore'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { hapticTap } from '../../../utils/haptics'
import { buildDiffPreview, type ChangedFile } from './changedFiles'

const MAX_VISIBLE = 6
/** 指针离开到关闭的宽限，够用户把指针移进浮层 */
const CLOSE_DELAY_MS = 120
/** 触摸端长按判定（ms）：按住超过该时长进入右侧面板 */
const LONG_PRESS_MS = 450
/** 长按期间手指移动超过该距离（px）视为「想滚动」，取消长按 */
const LONG_PRESS_MOVE_TOLERANCE = 8

interface DiffChipsProps {
  files: ChangedFile[]
  className?: string
}

/**
 * DiffChips — 改动文件概览条。
 *
 * 一排 `文件名 +N -M` 的胶囊：桌面端 hover / 聚焦弹出该文件的 diff 预览，
 * 点击落到右侧面板的 Changes 视图。触摸端没有 hover——手指点一下会合成
 * `mouseenter → click → mouseleave`，浮层刚开就被关，表现为看不到 + 闪烁——
 * 因此触摸端改用显式手势：点击切换预览，长按进入右侧面板。
 *
 * 两个实现要点：
 * 1. 同一文件多次修改已在上游合并为一条，chip 上标注 `×N`，
 *    预览里按次分段，避免概览条出现多个同名胶囊。
 * 2. 浮层只有一份，用虚拟锚点跟随当前 hover 的 chip。
 *    若每个 chip 各挂一个 Popover，切换时是两个独立浮层各自做进出场动画，
 *    视觉上是「旧的关、新的开」两次跳动；共用一份后切换只改锚点位置，
 *    浮层本身做平滑位移。
 */
export const DiffChips = memo(function DiffChips({ files, className }: DiffChipsProps) {
  const { t } = useTranslation('message')
  const { preferTouchUi } = useInputCapabilities()
  const [activePath, setActivePath] = useState<string | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 触摸端长按手势：定时器 + 起点，用于区分「长按进面板」与「点击看预览」。
  const longPressTimerRef = useRef<number | null>(null)
  const longPressFiredRef = useRef(false)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)

  /**
   * Radix 把定位 transform 写在浮层的父级 wrapper 上，transition 必须加在那一层。
   * 且首次打开时 Radix 从 `translate(0, -200%)` 移到目标位，若此时已有过渡会
   * 从远处「飞入」；因此等两帧定位稳定后再启用位移过渡，只让后续的锚点切换平滑。
   */
  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const wrapper = node.parentElement
    if (!wrapper) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrapper.style.transition = 'transform 160ms cubic-bezier(0.23, 1, 0.32, 1)'
      })
    })
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const open = useCallback(
    (path: string) => {
      cancelClose()
      setActivePath(path)
    },
    [cancelClose],
  )

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setActivePath(null)
    }, CLOSE_DELAY_MS)
  }, [cancelClose])

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      cancelClose()
      clearLongPress()
    },
    [cancelClose, clearLongPress],
  )

  const handlePointerDown = useCallback(
    (file: ChangedFile) => (event: React.PointerEvent<HTMLButtonElement>) => {
      // 触摸端才走长按；鼠标交给 hover / click。
      if (!preferTouchUi || event.pointerType === 'mouse') return
      const el = event.currentTarget
      longPressFiredRef.current = false
      pointerStartRef.current = { x: event.clientX, y: event.clientY }
      clearLongPress()
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null
        longPressFiredRef.current = true
        hapticTap('strong')
        // 标记为 none：抑制随后合成的 click 再补一记 light 震动。
        // 全局监听在捕获阶段先读到该标记，click 处理器随后清除它。
        el.setAttribute('data-haptic', 'none')
        setActivePath(null)
        layoutStore.revealChangesFile(file.path, 'right')
      }, LONG_PRESS_MS)
    },
    [preferTouchUi, clearLongPress],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!preferTouchUi) return
      const start = pointerStartRef.current
      if (!start || longPressTimerRef.current === null) return
      // 手指移动超过容差视为「想滚动」，取消长按，避免滑动时误触发面板。
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE) {
        clearLongPress()
      }
    },
    [preferTouchUi, clearLongPress],
  )

  const handlePointerEnd = useCallback(() => {
    clearLongPress()
    pointerStartRef.current = null
  }, [clearLongPress])

  const handleChipClick = useCallback(
    (file: ChangedFile) => (event: React.MouseEvent<HTMLButtonElement>) => {
      if (preferTouchUi) {
        // 长按已经进过面板，抑制紧随其后的合成 click，并清掉临时标记。
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false
          event.currentTarget.removeAttribute('data-haptic')
          return
        }
        anchorRef.current = event.currentTarget
        setActivePath(prev => (prev === file.path ? null : file.path))
        return
      }
      scheduleClose()
      layoutStore.revealChangesFile(file.path, 'right')
    },
    [preferTouchUi, scheduleClose],
  )

  const activeFile = useMemo(
    () => (activePath ? (files.find(file => file.path === activePath) ?? null) : null),
    [activePath, files],
  )

  if (files.length === 0) return null
  const visible = files.slice(0, MAX_VISIBLE)
  const overflow = files.length - visible.length

  return (
    <div
      ref={containerRef}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      onMouseLeave={preferTouchUi ? undefined : scheduleClose}
    >
      {visible.map(file => (
        <button
          key={file.path}
          type="button"
          onClick={handleChipClick(file)}
          onPointerDown={handlePointerDown(file)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          // hover / 聚焦只在可 hover 的设备上驱动预览；触摸端交给点击手势，
          // 避免合成的 mouseenter/mouseleave 让浮层一开就关。
          onMouseEnter={
            preferTouchUi
              ? undefined
              : event => {
                  anchorRef.current = event.currentTarget
                  open(file.path)
                }
          }
          onFocus={
            preferTouchUi
              ? undefined
              : event => {
                  anchorRef.current = event.currentTarget
                  open(file.path)
                }
          }
          onBlur={preferTouchUi ? undefined : scheduleClose}
          className={cn(
            'inline-flex h-6 max-w-[14rem] items-center gap-1.5 rounded-sm border px-1.5',
            'font-mono text-ui-xs',
            'transition-colors duration-150',
            activePath === file.path
              ? 'border-border-300 bg-bg-200 text-text-100'
              : 'border-border-200/50 bg-bg-100 text-text-300 hover:bg-bg-200',
          )}
          title={
            preferTouchUi
              ? t('diffChips.tapToPreview', { path: file.path })
              : t('diffChips.openInPanel', { path: file.path })
          }
          aria-label={
            preferTouchUi
              ? t('diffChips.tapToPreview', { path: file.path })
              : t('diffChips.openInPanel', { path: file.path })
          }
        >
          <FileGlyph path={file.path} />
          <span className="min-w-0 truncate">{basename(file.path)}</span>
          {file.additions > 0 && <span className="shrink-0 tabular-nums text-success-100">+{file.additions}</span>}
          {file.deletions > 0 && <span className="shrink-0 tabular-nums text-danger-100">-{file.deletions}</span>}
          {file.editCount > 1 && (
            <span
              className="shrink-0 tabular-nums text-text-500"
              title={t('diffChips.editCount', { count: file.editCount })}
            >
              ×{file.editCount}
            </span>
          )}
        </button>
      ))}

      {overflow > 0 && (
        <span className="font-mono text-ui-xs text-text-500">{t('diffChips.more', { count: overflow })}</span>
      )}

      <Popover open={!!activeFile} onOpenChange={next => !next && setActivePath(null)}>
        {/* 虚拟锚点：位置由 activePath 对应的 chip 决定，浮层只有这一份 */}
        <PopoverAnchor virtualRef={anchorRef} />
        <PopoverContent
          ref={setContentRef}
          align="start"
          sideOffset={6}
          className="w-[min(34rem,80vw)] p-0 text-ui-xs"
          onOpenAutoFocus={event => event.preventDefault()}
          // 触摸端点 chip 时，Radix 会把这次 pointerdown 当作「点浮层外部」而关闭。
          // 那是我们自己在处理的手势，阻止它，关闭/切换全由点击逻辑决定；
          // 点在 chip 之外则照常关闭。
          onInteractOutside={event => {
            if (preferTouchUi && event.target instanceof Node && containerRef.current?.contains(event.target)) {
              event.preventDefault()
            }
          }}
          onMouseEnter={preferTouchUi ? undefined : cancelClose}
          onMouseLeave={preferTouchUi ? undefined : scheduleClose}
        >
          {activeFile && <DiffPanel file={activeFile} />}
        </PopoverContent>
      </Popover>
    </div>
  )
})

function DiffPanel({ file }: { file: ChangedFile }) {
  const { t } = useTranslation('message')
  const sections = useMemo(() => buildDiffPreview(file.hunks), [file.hunks])

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border-200/50 px-2.5 py-1.5 font-mono">
        <NativeTooltip>
          <span className="min-w-0 flex-1 truncate text-text-300" title={file.path}>
            {file.path}
          </span>
        </NativeTooltip>
        <span className="shrink-0 tabular-nums">
          {file.additions > 0 && <span className="text-success-100">+{file.additions}</span>}
          {file.deletions > 0 && (
            <span className="text-danger-100">
              {file.additions > 0 ? ' ' : ''}-{file.deletions}
            </span>
          )}
        </span>
      </div>

      {/* 纵向滚动在外层，横向滚动只作用于代码内容。
          长行此前被 overflow-hidden + text-ellipsis 截断，看不全。
          hunk 标题用 sticky left-0 固定在左侧：横向滚动时标题与统计数保持可见，
          只有代码行随之左右移动，因此不再需要多个独立滚动条。 */}
      <div className="max-h-72 overflow-y-auto custom-scrollbar">
        {sections.map(section => (
          <div key={section.index} className="overflow-x-auto custom-scrollbar">
            {sections.length > 1 && (
              <div className="sticky left-0 flex w-fit min-w-full items-center gap-2 border-b border-border-200/30 bg-bg-200/40 px-2.5 py-1 font-mono text-text-500">
                <span>{t('diffChips.hunk', { index: section.index, total: sections.length })}</span>
                <span className="ml-auto tabular-nums">
                  {section.additions > 0 && <span className="text-success-100">+{section.additions}</span>}
                  {section.deletions > 0 && (
                    <span className="text-danger-100">
                      {section.additions > 0 ? ' ' : ''}-{section.deletions}
                    </span>
                  )}
                </span>
              </div>
            )}
            <div className="w-max min-w-full py-1 font-mono leading-[1.7]">
              {section.lines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    'flex gap-2 px-2.5 whitespace-pre',
                    line.type === 'add' ? 'bg-success-100/10 text-success-100' : '',
                    line.type === 'del' ? 'bg-danger-100/10 text-danger-100' : '',
                    line.type === 'ctx' ? 'text-text-400' : '',
                  )}
                >
                  <span className="w-3 shrink-0 select-none opacity-70">
                    {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                  </span>
                  <span>{line.text || ' '}</span>
                </div>
              ))}
              {section.truncated && <div className="px-2.5 py-1 text-text-500">{t('diffChips.truncated')}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function FileGlyph({ path }: { path: string }) {
  return (
    <img
      src={getMaterialIconUrl(path, 'file')}
      alt=""
      width={12}
      height={12}
      className="block size-3 shrink-0"
      loading="lazy"
      decoding="async"
      onError={event => {
        event.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}
