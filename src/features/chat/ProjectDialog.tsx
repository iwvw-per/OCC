import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderIcon, FolderOpenIcon, ArrowUpIcon, SpinnerIcon, PlusIcon, GitBranchIcon } from '../../components/Icons'
import { listDirectory, getPath, directoryExists } from '../../api'
import { runPtyCommand } from '../../api/ptyRun'
import { inferRepoName, isLikelyGitUrl } from './gitCloneUrl'
import { fileErrorHandler, isAbsoluteDirectory } from '../../utils'
import { canUseSystemDirectoryPicker } from '../../utils/nativeFileIntegration'
import { scrollItemIntoView } from '../../utils/scrollUtils'
import { Dialog } from '../../components/ui/Dialog'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'

// ============================================
// Types
// ============================================

interface ProjectDialogProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (path: string) => void
  initialPath?: string
  /** 浏览哪个服务器的文件系统（多服务器模式；缺省用活动服务器） */
  serverId?: string
}

interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
}

// ============================================
// Constants
// ============================================

// 始终使用正斜杠显示
const PATH_SEP = '/'

// ============================================
// Utils
// ============================================

function normalizePath(p: string): string {
  if (!p) return ''
  // 只转换反斜杠为正斜杠，保留尾斜杠（不能用 normalizeToForwardSlash，它会删尾斜杠）
  return p.replace(/\\/g, '/')
}

/**
 * 把用户输入整理成可展示的绝对路径起点。
 *
 * 相对路径（`../code/OCC`、`code/`）一律返回空串 —— 这里只认绝对路径，
 * 是否回落到服务端 home 交给调用方。
 */
function toAbsoluteStartingPath(p: string | undefined): string {
  if (!p) return ''
  const normalized = normalizePath(p.trim())
  if (!isAbsoluteDirectory(normalized)) return ''
  return normalized.endsWith(PATH_SEP) ? normalized : normalized + PATH_SEP
}

function getDirectoryPath(path: string): string {
  const normalized = normalizePath(path)
  if (normalized.endsWith(PATH_SEP)) return normalized
  const lastSep = normalized.lastIndexOf(PATH_SEP)
  if (lastSep < 0) return '.' + PATH_SEP
  return normalized.substring(0, lastSep + 1)
}

function getFilterText(path: string): string {
  const normalized = normalizePath(path)
  if (normalized.endsWith(PATH_SEP)) return ''
  const lastSep = normalized.lastIndexOf(PATH_SEP)
  return normalized.substring(lastSep + 1)
}

// ============================================
// Component
// ============================================

export function ProjectDialog({ isOpen, onClose, onSelect, initialPath = '', serverId }: ProjectDialogProps) {
  const { t } = useTranslation(['chat', 'common'])
  // State
  const [inputValue, setInputValue] = useState('')
  const [items, setItems] = useState<FileItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 输入框当前值不是绝对路径时展示的提示（不阻塞浏览，只阻止添加） */
  const [pathError, setPathError] = useState<string | null>(null)

  // ---- Git clone ----
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDirName, setCloneDirName] = useState('')
  const [cloneRunning, setCloneRunning] = useState(false)
  const [cloneOutput, setCloneOutput] = useState('')
  const [cloneError, setCloneError] = useState<string | null>(null)
  const cloneInputRef = useRef<HTMLInputElement>(null)

  // Refs
  const loadedPathRef = useRef<string>('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingSelectionRef = useRef<string | null>(null)
  const requestIdRef = useRef(0)
  /** 用户已经手动改过路径：迟到的异步初始化不得再覆盖输入框 */
  const userEditedRef = useRef(false)

  // Computed
  const currentDir = useMemo(() => getDirectoryPath(inputValue), [inputValue])
  const filterText = useMemo(() => getFilterText(inputValue), [inputValue])

  const filteredItems = useMemo(() => {
    if (!filterText) return items
    const lower = filterText.toLowerCase()
    return items.filter(item => item.name.toLowerCase().startsWith(lower))
  }, [items, filterText])

  // ==========================================
  // Initialize
  // ==========================================

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    userEditedRef.current = false

    const timer = window.setTimeout(() => {
      loadedPathRef.current = ''
      setItems([])

      const initPath = async () => {
        // 输入框只处理绝对路径：initialPath 不是绝对路径时直接回落到服务端 home。
        let home = ''
        try {
          const p = await getPath(serverId)
          home = p.home || ''
        } catch {
          /* ignore */
        }
        if (cancelled || userEditedRef.current) return

        let path = toAbsoluteStartingPath(initialPath) || toAbsoluteStartingPath(home)
        if (!path) {
          path = PATH_SEP
          setPathError(t('projectDialog.invalidPath'))
        } else {
          setPathError(null)
        }
        setInputValue(path)
        setSelectedIndex(0)
        pendingSelectionRef.current = null
        setTimeout(() => inputRef.current?.focus(), 50)
      }

      void initPath()
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isOpen, initialPath, serverId, t])

  // ==========================================
  // Load Directory
  // ==========================================

  useEffect(() => {
    if (!isOpen || !currentDir) return
    // 相对路径（用户正在输入 `../code/`）没法列目录：等输入变成绝对路径再加载，
    // 避免一次必然失败的请求把列表清空成报错。
    if (!isAbsoluteDirectory(currentDir)) return
    // 目录变化时始终重新加载
    if (currentDir === loadedPathRef.current) return

    let cancelled = false
    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      setIsLoading(true)
      setError(null)

      listDirectory(currentDir, undefined, serverId)
        .then(nodes => {
          if (cancelled || requestId !== requestIdRef.current) return

          const fileItems = nodes
            .filter(n => n.type === 'directory')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(n => ({
              name: n.name,
              path: normalizePath(n.absolute),
              type: n.type,
            }))

          setItems(fileItems)
          loadedPathRef.current = currentDir

          if (pendingSelectionRef.current) {
            const idx = fileItems.findIndex(item => item.name === pendingSelectionRef.current)
            setSelectedIndex(idx !== -1 ? idx : 0)
            pendingSelectionRef.current = null
          } else {
            setSelectedIndex(0)
          }
        })
        .catch(err => {
          if (cancelled || requestId !== requestIdRef.current) return
          fileErrorHandler('list directory', err)
          setError(err.message)
          setItems([])
          loadedPathRef.current = ''
        })
        .finally(() => {
          if (!cancelled && requestId === requestIdRef.current) {
            setIsLoading(false)
          }
        })
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isOpen, currentDir, serverId])

  // ==========================================
  // Scroll to Selection
  // ==========================================

  // 滚动选中项到可见区域
  useLayoutEffect(() => {
    if (selectedIndex < 0) return
    const container = scrollContainerRef.current
    const el = document.getElementById(`project-item-${selectedIndex}`)
    if (container && el) {
      scrollItemIntoView(container, el)
    }
  }, [selectedIndex, filteredItems])

  /**
   * 保证输入框显示的就是 inputValue。
   *
   * 受控 input 正常情况下由 React 同步；但对话框在「上级 → 点目录」连点时，
   * 若期间有其它渲染打断（或浏览器保留了输入法/选中态），DOM 会残留旧值，
   * 后续点击就会基于旧路径拼出 `../code/...`。这里兜一层显式同步。
   */
  useLayoutEffect(() => {
    const el = inputRef.current
    if (el && el.value !== inputValue) el.value = inputValue
  }, [inputValue])

  // ==========================================
  // Handlers
  // ==========================================

  /**
   * 返回上一级：就在当前绝对路径上砍掉最后一段。
   *
   * `/opt/code/OCC/` → `/opt/code/`，`/opt/` → `/`。不做 dot-segment 折叠、
   * 也不做任何补全 —— 输入框里只有绝对路径，砍一刀就是父目录。
   */
  const handleGoBack = useCallback(() => {
    userEditedRef.current = true
    const normalized = normalizePath(inputValue.trim())
    // 只处理绝对路径；相对路径（`../code/`）原样保留，不猜、不补全
    if (!isAbsoluteDirectory(normalized)) return
    // 去掉末尾斜杠后按最后一段切分；根路径（`/`、`C:/`）不再上退
    const trimmed = normalized.replace(/\/+$/, '')
    if (!trimmed || /^[a-zA-Z]:$/.test(trimmed)) return
    const parent = getDirectoryPath(trimmed)
    const folderName = trimmed.split(PATH_SEP).filter(Boolean).pop()
    if (folderName) pendingSelectionRef.current = folderName
    // 目录路径必须带尾斜杠：末尾是文件名时会被当成过滤词，列表看起来像空的
    setInputValue(parent.endsWith(PATH_SEP) ? parent : parent + PATH_SEP)
  }, [inputValue])

  const handleItemClick = useCallback(
    (item: FileItem) => {
      userEditedRef.current = true
      // 列表项自带绝对路径（来自 listDirectory 的 absolute），直接用它拼尾斜杠，
      // 不依赖输入框当时的文本 —— 即使输入框因某种原因停留在旧目录，点哪进哪。
      const absolute = isAbsoluteDirectory(item.path) ? item.path : loadedPathRef.current + item.name
      setInputValue(toAbsoluteStartingPath(absolute))
      setPathError(null)
      inputRef.current?.focus()
    },
    [],
  )

  const handleSelectFolder = useCallback(
    (folderPath: string) => {
      onSelect(folderPath)
      onClose()
    },
    [onSelect, onClose],
  )

  /** 把当前输入作为项目目录提交（只接受绝对路径） */
  const handleConfirmCurrent = useCallback(() => {
    // 去掉尾斜杠，但保留根路径（/ 或 C:/）
    let path = inputValue.trim()
    if (path !== PATH_SEP && !/^[a-zA-Z]:\/$/.test(path)) path = path.replace(/\/+$/, '')
    if (!path || path === '.') return
    // 后端只接受绝对路径：相对路径（`../code/OCC`、`foo/bar`）会让后续
    // 列目录/查询会话全部失败，且被侧栏误判为「目录不存在」。
    if (!isAbsoluteDirectory(path)) {
      setPathError(t('projectDialog.invalidPath'))
      return
    }
    setPathError(null)
    onSelect(path)
    onClose()
  }, [inputValue, onSelect, onClose, t])

  /**
   * 用系统文件夹选择器挑目录。
   *
   * 桌面客户端始终可用：用户大多连接云端/远程服务器，此时若按「焦点服务器必须是
   * 本机」来门控，这个按钮就永远不会出现，只能靠上方路径浏览。所选目录会作为
   * 本机路径写入项目列表；远程目录仍可用上方的路径浏览（走网关读远程文件系统）。
   */
  const canUseNativePicker = canUseSystemDirectoryPicker()
  const handleNativePick = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('projectDialog.pickInFileManager'),
      })
      if (typeof selected === 'string' && selected) {
        onSelect(selected)
        onClose()
      }
    } catch (err) {
      fileErrorHandler('open directory picker', err)
    }
  }, [onSelect, onClose, t])

  // ---- Git clone ----
  const resetCloneState = useCallback(() => {
    setCloneUrl('')
    setCloneDirName('')
    setCloneOutput('')
    setCloneError(null)
    setCloneRunning(false)
  }, [])

  const openClone = useCallback(() => {
    resetCloneState()
    setCloneOpen(true)
    // 克隆到当前浏览的目录下
    window.setTimeout(() => cloneInputRef.current?.focus(), 50)
  }, [resetCloneState])

  const handleCloneUrlChange = useCallback(
    (value: string) => {
      setCloneUrl(value)
      // 目录名只在用户没手动改过时跟随 URL
      setCloneDirName(prev => (prev === '' || prev === inferRepoName(cloneUrl) ? inferRepoName(value) : prev))
    },
    [cloneUrl],
  )

  /**
   * 执行 git clone。
   *
   * 目标目录 = 当前浏览目录 / 目录名。成功后把该目录作为项目返回；
   * 失败时把 git 的报错留在对话框里（常见：目录已存在、无权限、认证失败）。
   */
  const handleClone = useCallback(async () => {
    const url = cloneUrl.trim()
    const dirName = cloneDirName.trim()
    if (!isLikelyGitUrl(url)) {
      setCloneError(t('projectDialog.cloneInvalidUrl'))
      return
    }
    if (!dirName || /[/\\]/.test(dirName) || dirName === '.' || dirName === '..') {
      setCloneError(t('projectDialog.cloneInvalidName'))
      return
    }

    const baseDir = getDirectoryPath(inputValue)
    const targetDir = normalizePath(baseDir).replace(/\/+$/, '') + PATH_SEP + dirName

    setCloneRunning(true)
    setCloneError(null)
    setCloneOutput('')

    try {
      const result = await runPtyCommand({
        command: 'git',
        args: ['clone', '--progress', url, targetDir],
        cwd: baseDir || PATH_SEP,
        directory: serverId ? baseDir : undefined,
        serverId,
      })
      setCloneOutput(result.output)

      // 退出码不可全信：PTY 在进程结束后可能被服务端立即回收，
      // 此时拿不到真实退出码（runPtyCommand 按 0 处理）。用「目标目录是否
      // 已出现」作为最终判据 —— 这是用户真正关心的结果。
      const cloned = await directoryExists(targetDir, serverId).catch(() => false)
      if (!cloned) {
        setCloneError(t('projectDialog.cloneFailed', { code: result.exitCode }))
        return
      }

      onSelect(targetDir)
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCloneError(message)
    } finally {
      setCloneRunning(false)
    }
  }, [cloneUrl, cloneDirName, inputValue, serverId, onSelect, onClose, t])

  const closeClone = useCallback(() => {
    if (cloneRunning) return
    setCloneOpen(false)
    resetCloneState()
  }, [cloneRunning, resetCloneState])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const hasGoUp = inputValue.split(PATH_SEP).filter(Boolean).length > 0
      const minIndex = hasGoUp ? -1 : 0
      const maxIndex = filteredItems.length - 1
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev >= maxIndex ? minIndex : prev + 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev <= minIndex ? maxIndex : prev - 1))
          break
        case 'ArrowRight':
        case 'Tab':
          if (filteredItems.length > 0) {
            e.preventDefault()
            const selected = filteredItems[selectedIndex]
            setInputValue(selected.path + PATH_SEP)
            setSelectedIndex(0)
          }
          break
        case 'ArrowLeft': {
          const inputEl = e.currentTarget as HTMLInputElement
          const isAtStart = inputEl.selectionStart === 0 && inputEl.selectionEnd === 0
          if (isAtStart || inputValue.endsWith(PATH_SEP)) {
            e.preventDefault()
            // 只在绝对路径上退一级；相对路径不动
            handleGoBack()
            inputRef.current?.focus()
          }
          break
        }
        case 'Enter':
          e.preventDefault()
          if (filteredItems.length > 0) {
            const selectedPath = filteredItems[selectedIndex].path
            if (selectedPath) {
              onSelect(selectedPath)
              onClose()
            }
          } else {
            // 与「添加当前目录」同一套校验，避免回车绕过绝对路径检查
            handleConfirmCurrent()
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [filteredItems, selectedIndex, inputValue, handleGoBack, handleConfirmCurrent, onSelect, onClose],
  )

  // ==========================================
  // Render
  // ==========================================

  const trimmedInput = inputValue.trim()
  const relativeInput = !!trimmedInput && !isAbsoluteDirectory(trimmedInput)
  // 触摸设备没有 hover：条目的「添加」按钮不能只在 hover 选中行渲染。
  // 用项目已有的输入能力检测（matchMedia 的 hover/pointer，带全局共享订阅），
  // 比 `'ontouchstart' in window` 准确 —— 后者在触屏笔记本上会误判成纯触控。
  const { canHover } = useInputCapabilities()
  const touchOnly = !canHover

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      rawContent
      width={720}
      showCloseButton={false}
      allowTouchBackdropClose
      className="h-[min(620px,100%)]"
    >
      {/* Header */}
      <div className="p-4 pb-2 shrink-0">
        <div className="relative bg-bg-000/40 rounded-lg border border-border-200/60 focus-within:border-accent-main-100/50 transition-colors flex items-center px-3 py-2.5">
          <FolderIcon className="text-text-400 w-4 h-4 shrink-0 mr-2.5" />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => {
              // 用户手动输入：标记后，迟到的异步初始化不得再覆盖
              userEditedRef.current = true
              setInputValue(e.target.value)
              setSelectedIndex(0)
              if (pathError) setPathError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('projectDialog.typePath')}
            className="flex-1 bg-transparent border-none outline-none text-[length:var(--fs-base)] text-text-100 placeholder:text-text-400 font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          {isLoading && <SpinnerIcon className="animate-spin text-text-400 w-4 h-4" size={16} />}
        </div>
        {pathError && (
          <div
            role="alert"
            className="mt-2 rounded-md border border-danger-100/40 bg-danger-100/10 px-3 py-2 text-[length:var(--fs-xs)] text-danger-100"
          >
            {pathError}
          </div>
        )}
      </div>

      {/* List */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-2 py-1 custom-scrollbar">
        {/* 输入框不是绝对路径：说明后端不会接受，提示改成绝对路径 */}
        {!error && relativeInput ? (
          <div
            className="rounded-md border border-border-200/60 bg-bg-000/40 px-3 py-2 text-[length:var(--fs-xs)] text-text-400"
            data-testid="relative-path-hint"
          >
            {t('projectDialog.invalidPath')}
          </div>
        ) : null}
        {error ? (
          <div className="flex items-center justify-center h-full text-danger-100 text-[length:var(--fs-sm)] px-4 text-center">
            {error}
          </div>
        ) : (
          <div className="space-y-0.5">
            {/* Go Up */}
            {inputValue.split(PATH_SEP).filter(Boolean).length > 0 && (
              <ListItem
                id="project-item-up"
                icon={<ArrowUpIcon className="w-3.5 h-3.5" />}
                label={t('projectDialog.parent')}
                isSelected={selectedIndex === -1}
                onClick={() => {
                  handleGoBack()
                  inputRef.current?.focus()
                }}
                onMouseEnter={() => setSelectedIndex(-1)}
              />
            )}

            {/* Empty State */}
            {filteredItems.length === 0 && !isLoading && (
              <div className="flex flex-col items-center justify-center h-28 text-text-400/60 text-[length:var(--fs-sm)] gap-2">
                <FolderIcon className="w-6 h-6 opacity-30" />
                <span>{filterText ? t('projectDialog.noMatchingFolders') : t('common:emptyFolder')}</span>
              </div>
            )}

            {/* Items */}
            {filteredItems.map((item, index) => (
              <ListItem
                key={item.name}
                id={`project-item-${index}`}
                icon={<FolderIcon className="w-3.5 h-3.5" />}
                label={item.name}
                isSelected={index === selectedIndex}
                onClick={() => handleItemClick(item)}
                onMouseEnter={() => setSelectedIndex(index)}
                onPointerDown={() => setSelectedIndex(index)}
                action={
                  // 桌面端只在「选中行」显示，悬停即选中，视觉更干净。
                  // 触摸设备没有 hover，selectedIndex 基本停在 0，若沿用同一条件，
                  // 除第一行外的条目永远没有「添加」按钮 —— 表现为「条目上的添加无效」。
                  // 触控下改为常显，并靠 onPointerDown 同步选中项。
                  (touchOnly || index === selectedIndex) && (
                    <button
                      type="button"
                      aria-label={t('common:add')}
                      onClick={e => {
                        e.stopPropagation()
                        handleSelectFolder(item.path)
                      }}
                      className="flex items-center gap-1 text-[length:var(--fs-xxs)] bg-accent-main-100 hover:bg-accent-main-200 px-2 py-0.5 rounded text-oncolor-100 font-medium transition-colors"
                    >
                      <PlusIcon className="w-2.5 h-2.5" />
                      {t('common:add')}
                    </button>
                  )
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Git clone 面板：仅在点击「克隆 Git 仓库」后展开 */}
      {cloneOpen && (
        <div className="shrink-0 border-t border-border-200/40 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <GitBranchIcon className="w-3.5 h-3.5 shrink-0 text-text-400" />
            <span className="text-[length:var(--fs-sm)] font-medium text-text-200">
              {t('projectDialog.cloneGitTitle')}
            </span>
          </div>

          <input
            ref={cloneInputRef}
            type="text"
            value={cloneUrl}
            onChange={e => handleCloneUrlChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !cloneRunning) {
                e.preventDefault()
                void handleClone()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeClone()
              }
            }}
            placeholder={t('projectDialog.cloneUrlPlaceholder')}
            disabled={cloneRunning}
            className="w-full rounded-md border border-border-200/60 bg-bg-000/40 px-3 py-2 font-mono text-[length:var(--fs-sm)] text-text-100 outline-none placeholder:text-text-400 focus:border-accent-main-100/50 disabled:opacity-60"
            autoComplete="off"
            spellCheck={false}
          />

          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[length:var(--fs-xxs)] text-text-400">
              {t('projectDialog.cloneInto')}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xxs)] text-text-300"
              title={inputValue}
            >
              {inputValue}
            </span>
          </div>

          <input
            type="text"
            value={cloneDirName}
            onChange={e => setCloneDirName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !cloneRunning) {
                e.preventDefault()
                void handleClone()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeClone()
              }
            }}
            placeholder={t('projectDialog.cloneDirNamePlaceholder')}
            disabled={cloneRunning}
            className="w-full rounded-md border border-border-200/60 bg-bg-000/40 px-3 py-2 font-mono text-[length:var(--fs-sm)] text-text-100 outline-none placeholder:text-text-400 focus:border-accent-main-100/50 disabled:opacity-60"
            autoComplete="off"
            spellCheck={false}
          />

          {cloneError && (
            <div className="rounded-md border border-danger-100/40 bg-danger-100/10 px-3 py-2 text-[length:var(--fs-xs)] text-danger-100">
              {cloneError}
            </div>
          )}

          {cloneOutput && (
            <pre className="max-h-28 overflow-auto rounded-md border border-border-200/40 bg-bg-000/60 p-2 font-mono text-[length:var(--fs-xxs)] leading-4 text-text-300 whitespace-pre-wrap break-all">
              {cloneOutput}
            </pre>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeClone}
              disabled={cloneRunning}
              className={cn(
                'rounded-md px-3 py-1.5 text-[length:var(--fs-sm)] text-text-300 transition-colors hover:bg-bg-200 disabled:opacity-50',
                interactive.subtle,
              )}
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleClone()}
              disabled={cloneRunning || !cloneUrl.trim() || !cloneDirName.trim()}
              className={cn(
                'flex items-center gap-1.5 rounded-md bg-accent-main-100 px-3 py-1.5 text-[length:var(--fs-sm)] font-medium text-oncolor-100 transition-colors hover:bg-accent-main-200 disabled:opacity-50',
                interactive.accent,
              )}
            >
              {cloneRunning ? (
                <>
                  <SpinnerIcon className="w-3 h-3 animate-spin" size={12} />
                  {t('projectDialog.cloning')}
                </>
              ) : (
                t('projectDialog.cloneStart')
              )}
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="relative p-3 flex items-center gap-3 shrink-0">
        <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-border-200/30" />
        <div className="text-[length:var(--fs-xxs)] text-text-400 flex-1 min-w-0 font-mono whitespace-normal break-all leading-4">
          {inputValue}
        </div>
        {canUseNativePicker && (
          <button
            type="button"
            onClick={handleNativePick}
            title={t('projectDialog.pickInFileManager')}
            aria-label={t('projectDialog.pickInFileManager')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 bg-bg-000/40 border border-border-200/60 hover:border-accent-main-100/30 text-text-200 rounded-md text-[length:var(--fs-sm)] font-medium shrink-0 whitespace-nowrap max-sm:px-2',
              interactive.subtle,
            )}
          >
            <FolderOpenIcon className="w-3 h-3 shrink-0" />
            {/* 移动端空间紧张：只留图标，文案由 title/aria-label 提供 */}
            <span className="hidden sm:inline">{t('projectDialog.pickInFileManager')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={openClone}
          title={t('projectDialog.cloneGit')}
          aria-label={t('projectDialog.cloneGit')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 bg-bg-000/40 border border-border-200/60 hover:border-accent-main-100/30 text-text-200 rounded-md text-[length:var(--fs-sm)] font-medium shrink-0 whitespace-nowrap max-sm:px-2',
            interactive.subtle,
          )}
        >
          <GitBranchIcon className="w-3 h-3 shrink-0" />
          <span className="hidden sm:inline">{t('projectDialog.cloneGit')}</span>
        </button>
        <button
          type="button"
          onClick={handleConfirmCurrent}
          title={t('projectDialog.addCurrent')}
          aria-label={t('projectDialog.addCurrent')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 bg-bg-000/40 border border-border-200/60 hover:border-accent-main-100/30 text-text-200 rounded-md text-[length:var(--fs-sm)] font-medium shrink-0 whitespace-nowrap max-sm:px-2',
            interactive.accent,
          )}
        >
          <PlusIcon className="w-3 h-3 shrink-0" />
          <span className="hidden sm:inline">{t('projectDialog.addCurrent')}</span>
        </button>
      </div>
    </Dialog>
  )
}

// ============================================
// ListItem Component
// ============================================

interface ListItemProps {
  id: string
  icon: React.ReactNode
  label: string
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
  /** 触摸端用于同步选中项（没有 hover，selectedIndex 不会自己更新） */
  onPointerDown?: () => void
  action?: React.ReactNode
}

function ListItem({ id, icon, label, isSelected, onClick, onMouseEnter, onPointerDown, action }: ListItemProps) {
  return (
    <div
      id={id}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onPointerDown={onPointerDown}
      className={`
        flex items-center justify-between px-3 py-2 rounded-md cursor-pointer transition-all duration-150
        ${isSelected ? 'bg-bg-200/60 text-text-100' : 'text-text-300 hover:bg-bg-200'}
      `}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={isSelected ? 'text-accent-main-100' : 'text-text-400'}>{icon}</span>
        <span className="text-[length:var(--fs-base)] truncate">{label}</span>
      </div>
      {action}
    </div>
  )
}
