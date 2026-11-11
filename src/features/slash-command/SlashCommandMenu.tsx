// ============================================
// SlashCommandMenu Component
// 斜杠命令选择菜单
// ============================================

import { useState, useEffect, useLayoutEffect, useRef, useImperativeHandle, forwardRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { getCommands, type Command } from '../../api/command'
import { apiErrorHandler } from '../../utils'
import { scrollItemIntoView } from '../../utils/scrollUtils'

// ============================================
// Types
// ============================================

interface SlashCommandMenuProps {
  isOpen: boolean
  query: string // "/" 之后的文本
  rootPath?: string // 用于 API 调用
  onSelect: (command: Command) => void
  onClose: () => void
}

// 暴露给父组件的方法
export interface SlashCommandMenuHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
  getSelectedCommand: () => Command | null
}

// ============================================
// SlashCommandMenu Component
// ============================================

export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, SlashCommandMenuProps>(function SlashCommandMenu(
  { isOpen, query, rootPath, onSelect, onClose },
  ref,
) {
  const { t } = useTranslation(['commands', 'common'])
  const [commands, setCommands] = useState<Command[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dynamicMaxHeight, setDynamicMaxHeight] = useState<number | undefined>(undefined)
  const requestIdRef = useRef(0)
  const filteredCommands = useMemo(() => {
    if (!isOpen) return []

    const lowerQuery = query.toLowerCase()
    return commands.filter(
      cmd => cmd.name.toLowerCase().includes(lowerQuery) || cmd.description?.toLowerCase().includes(lowerQuery),
    )
  }, [commands, isOpen, query])
  /**
   * 命令名列宽：按**当前过滤结果**里最长的命令自适应，不再截断。
   *
   * 旧实现有两个问题：
   *   1. 上限写死 18ch（`Math.min(..., 18)`），而 `/open-code-review` 加前导 `/`
   *      需要 18ch 以上，于是被截成 `/open-code-revie...` —— 用户根本分不清
   *      是哪一条；
   *   2. 用全量 `commands` 计算，过滤后列表变短时列宽也不会收窄。
   *
   * 这里改成按过滤后的列表计算，并设一个上限防止极端长名把描述挤没
   * （超过上限才截断，正常命令都放得下）。
   */
  const commandColumnWidth = useMemo(() => {
    const longest = filteredCommands.reduce((max, cmd) => Math.max(max, cmd.name.length + 1), 0)
    return `${Math.min(Math.max(longest + 1, 8), 28)}ch`
  }, [filteredCommands])
  const activeIndex = filteredCommands.length === 0 ? 0 : Math.min(selectedIndex, filteredCommands.length - 1)

  // 动态计算菜单最大高度，防止在小屏幕上被 header 遮挡
  useLayoutEffect(() => {
    let frameId: number | null = null
    let resizeRaf = 0
    // 阴影元素缓存：菜单开期内 header/阴影不变，避免每次 resize 都 querySelector。
    // undefined=未查询, null=查询过但未找到, HTMLElement=已找到
    let shadowEl: HTMLElement | null | undefined = undefined

    const calculate = () => {
      const el = menuRef.current
      if (!el) {
        setDynamicMaxHeight(undefined)
        return
      }
      const parent = el.offsetParent as HTMLElement | null
      if (!parent) {
        setDynamicMaxHeight(undefined)
        return
      }
      if (shadowEl === undefined) {
        shadowEl =
          parent.closest<HTMLElement>('[data-chat-pane-root]')?.querySelector<HTMLElement>('[data-chat-header-shadow]') ?? null
      }
      const parentRect = parent.getBoundingClientRect()
      // 阴影底边 = 菜单顶部不可越过的线（header + 渐变阴影）。
      // 直接测量阴影元素，不硬编码高度，兼容 --app-safe-top 与未来调整。
      const ceiling = shadowEl ? shadowEl.getBoundingClientRect().bottom : 0
      // 可用空间 = 父容器顶部 - 阴影底边 - marginBottom(8px)
      const available = parentRect.top - ceiling - 8
      /**
       * 只有真的「放不下」时才压高度。
       *
       * 旧阈值 360：可用空间 ≥360 就交回给 CSS 的默认上限（当时是 320），
       * 等于无论如何都封在 320 左右。现在默认上限提到 520，阈值同步提到 520，
       * 否则可用空间 400~520 之间会被错误地压到 400 出头。
       */
      if (available > 0 && available < 520) {
        setDynamicMaxHeight(available)
      } else {
        setDynamicMaxHeight(undefined)
      }
    }

    // rAF 合并同帧多次 resize（移动端键盘弹出/收起会高频触发）
    const onResize = () => {
      if (resizeRaf) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        calculate()
      })
    }

    if (isOpen) {
      frameId = requestAnimationFrame(calculate)
    } else {
      frameId = requestAnimationFrame(() => setDynamicMaxHeight(undefined))
    }

    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [isOpen])

  // 加载命令列表
  useEffect(() => {
    if (!isOpen) return

    const frameId = requestAnimationFrame(() => {
      const requestId = ++requestIdRef.current
      setLoading(true)

      getCommands(rootPath)
        .then(cmds => {
          if (requestId !== requestIdRef.current) return
          setCommands(cmds)
          setSelectedIndex(0)
        })
        .catch(err => {
          if (requestId !== requestIdRef.current) return
          apiErrorHandler('load commands', err)
          setCommands([])
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setLoading(false)
          }
        })
    })

    return () => cancelAnimationFrame(frameId)
  }, [isOpen, rootPath])

  // query 变化时重置选中项
  useEffect(() => {
    if (!isOpen) return

    const frameId = requestAnimationFrame(() => {
      setSelectedIndex(0)
    })

    return () => cancelAnimationFrame(frameId)
  }, [isOpen, query])

  // 滚动选中项到可见区域
  useLayoutEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.children[activeIndex] as HTMLElement
    if (selectedEl) {
      scrollItemIntoView(listRef.current, selectedEl)
    }
  }, [activeIndex])

  // 暴露方法给父组件
  useImperativeHandle(
    ref,
    () => ({
      moveUp: () => {
        setSelectedIndex(prev => (prev <= 0 ? filteredCommands.length - 1 : prev - 1))
      },
      moveDown: () => {
        setSelectedIndex(prev => (prev >= filteredCommands.length - 1 ? 0 : prev + 1))
      },
      selectCurrent: () => {
        const selected = filteredCommands[activeIndex]
        if (selected) {
          onSelect(selected)
        }
      },
      getSelectedCommand: () => filteredCommands[activeIndex] || null,
    }),
    [filteredCommands, activeIndex, onSelect],
  )

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    if (isOpen) {
      document.addEventListener('pointerdown', handleClickOutside)
      return () => document.removeEventListener('pointerdown', handleClickOutside)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      ref={menuRef}
      data-dropdown-open
      /**
       * 宽度跟随输入框容器（父级是 `relative` + chat-content-width）。
       *
       * 这里**不能**再写 `md:max-w-[360px]`：那会让命令面板在桌面上比输入框窄一截，
       * 视觉上像一张浮在旁边的卡片而不是输入框的延伸。`w-full` 即对齐。
       */
      className="absolute z-50 w-full flex flex-col glass border border-border-200/60 rounded-xl shadow-lg overflow-hidden"
      style={{
        bottom: '100%',
        left: 0,
        marginBottom: '8px',
        /**
         * 默认高度上限。
         *
         * 旧值 320px 只放得下 7 行左右，命令一多就要滚动；命令列表本身信息密度
         * 很低（一行命令 + 一行描述），给到 520px 更接近「一眼看完」。
         * `calc(100dvh - 10rem)` 仍然兜住矮屏（移动端键盘弹起时不会顶出视口）。
         */
        maxHeight: dynamicMaxHeight ? `${dynamicMaxHeight}px` : 'min(520px, calc(100dvh - 10rem))',
      }}
    >
      {/* Items List */}
      <div ref={listRef} className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-0.5 p-1.5">
        {loading && <div className="px-2 py-4 text-center text-[length:var(--fs-base)] text-text-400">{t('common:loading')}</div>}

        {!loading && filteredCommands.length === 0 && (
          <div className="px-2 py-4 text-center text-[length:var(--fs-base)] text-text-400">
            {query ? t('slashCommand.noMatchingCommands') : t('slashCommand.noCommandsAvailable')}
          </div>
        )}

        {filteredCommands.map((cmd, index) => (
          <button
            key={cmd.name}
            title={cmd.description}
            className={`w-full px-2.5 py-2 md:py-1.5 flex items-center gap-3 text-left rounded-lg transition-colors ${
              index === activeIndex ? 'bg-bg-200 text-text-100' : 'text-text-200 hover:bg-bg-200'
            }`}
            onClick={() => onSelect(cmd)}
            onPointerEnter={() => setSelectedIndex(index)}
          >
            <span
              className={`font-mono text-[length:var(--fs-base)] flex-shrink-0 leading-5 whitespace-nowrap ${
                index === activeIndex ? 'text-accent-main-100' : 'text-text-300'
              }`}
              /**
               * 统一列宽（不是 minWidth）：所有描述从同一列开始，视觉整齐。
               * 宽度由「本次过滤结果里最长的命令名」算出，因此 /open-code-review
               * 这种长名不会再被截成 `/open-code-revie...`。
               */
              style={{ width: commandColumnWidth }}
            >
              /{cmd.name}
            </span>
            <div className="flex-1 min-w-0">
              {cmd.description && <div className="text-[length:var(--fs-sm)] text-text-400 truncate">{cmd.description}</div>}
            </div>
            {cmd.keybind && <span className="text-[length:var(--fs-sm)] text-text-500 font-mono flex-shrink-0">{cmd.keybind}</span>}
          </button>
        ))}
      </div>

      {/* Footer Hints - 只在桌面端显示 */}
      <div className="hidden md:flex px-3 py-1.5 text-[length:var(--fs-xs)] text-text-500/70 gap-3">
        <span>{t('common:upDownSelect')}</span>
        <span>{t('common:enterRun')}</span>
        <span>{t('common:escCancel')}</span>
      </div>
    </div>
  )
})
