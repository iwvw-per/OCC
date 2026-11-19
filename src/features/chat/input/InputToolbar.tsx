import { useRef, useCallback, useMemo } from 'react'
import { logger } from '../../../utils/logger'
import { useTranslation } from 'react-i18next'
import { PaperclipIcon } from '../../../components/Icons'
import { IconButton, AnimatedPresence } from '../../../components/ui'
import { ModelSelector, type ModelSelectorHandle } from '../ModelSelector'
import { useChatViewport } from '../chatViewport'
import { isTauri, isTauriMobile, extToMime } from '../../../utils/tauri'
import type { ModelInfo, FileCapabilities } from '../../../api'

interface InputToolbarProps {
  variants?: string[]
  selectedVariant?: string
  onVariantChange?: (variant: string | undefined) => void

  fileCapabilities?: FileCapabilities
  onFilesSelected: (files: File[]) => void

  /** 发送中：禁用选择器与附件，避免中途改模型/添附件 */
  isSending?: boolean

  // Model selection（移动端显示在工具栏）
  models?: ModelInfo[]
  selectedModelKey?: string | null
  onModelChange?: (modelKey: string, model: ModelInfo) => void
  modelsLoading?: boolean
  // 输入框容器 ref，用于约束菜单边界
  inputContainerRef?: React.RefObject<HTMLDivElement | null>
  modelSelectorRef?: React.RefObject<ModelSelectorHandle | null>
  /** 模型菜单开合:菜单打开时抑制输入框滚动收起 */
  onModelMenuOpenChange?: (open: boolean) => void
}

export function InputToolbar({
  variants = [],
  selectedVariant,
  onVariantChange,
  fileCapabilities,
  onFilesSelected,
  isSending = false,
  models = [],
  selectedModelKey = null,
  onModelChange,
  modelsLoading = false,
  inputContainerRef,
  modelSelectorRef,
  onModelMenuOpenChange,
}: InputToolbarProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { presentation } = useChatViewport()
  const isCompact = presentation.isCompact
  const useBrowserFileInput = !isTauri() || isTauriMobile()

  // 根据模型能力计算支持的文件类型
  //
  // text 缺省为 true：文本类附件不依赖模型的多模态能力（服务端内联成文本），
  // 且「大段文本→作为附件」依赖它。旧调用方不传时行为与现在一致。
  const caps = fileCapabilities ?? { image: false, pdf: false, audio: false, video: false, text: true }
  const supportsAnyFile = caps.image || caps.pdf || caps.audio || caps.video || caps.text === true
  const controlsDisabled = isSending

  // 动态构建 HTML accept 和 Tauri filter
  const { acceptString, tauriFilters } = useMemo(() => {
    const accept: string[] = []
    const extensions: string[] = []
    const filterNames: string[] = []

    if (caps.image) {
      accept.push('image/*')
      extensions.push('png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg')
      filterNames.push(t('inputToolbar.filterImages'))
    }
    if (caps.pdf) {
      accept.push('application/pdf')
      extensions.push('pdf')
      filterNames.push(t('inputToolbar.filterPdf'))
    }
    if (caps.audio) {
      accept.push('audio/*')
      extensions.push('mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a')
      filterNames.push(t('inputToolbar.filterAudio'))
    }
    if (caps.video) {
      accept.push('video/*')
      extensions.push('mp4', 'webm', 'mov', 'avi', 'mkv')
      filterNames.push(t('inputToolbar.filterVideo'))
    }
    if (caps.text !== false) {
      // 文本类：浏览器 accept 用 text/* + 常见 application 文本类型；
      // Tauri 原生选择框只能按扩展名，这里列常用的一组。
      accept.push('text/*', 'application/json', 'application/xml', 'application/x-yaml')
      extensions.push(
        'txt',
        'md',
        'markdown',
        'csv',
        'json',
        'log',
        'yaml',
        'yml',
        'xml',
        'html',
        'css',
        'js',
        'ts',
        'py',
        'java',
        'go',
        'rs',
        'sh',
        'sql',
        'ini',
        'toml',
      )
      filterNames.push(t('inputToolbar.filterText'))
    }

    return {
      acceptString: accept.join(','),
      tauriFilters: extensions.length > 0 ? [{ name: filterNames.join(' / '), extensions }] : [],
    }
  }, [caps.image, caps.pdf, caps.audio, caps.video, caps.text, t])
  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileClick = useCallback(async () => {
    if (useBrowserFileInput) {
      fileInputRef.current?.click()
      return
    }

    try {
      const [{ open }, { readFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ])

      const selected = await open({
        multiple: true,
        filters: tauriFilters,
        fileAccessMode: 'copy',
      })

      if (!selected) return

      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return

      const files: File[] = []
      for (const path of paths) {
        const fileName = path.split(/[\\/]/).pop() || 'file'
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const mime = extToMime(ext)

        const data = await readFile(path)
        const file = new File([data], fileName, { type: mime })
        files.push(file)
      }

      if (files.length > 0) {
        onFilesSelected(files)
      }
    } catch (err) {
      logger.warn('[InputToolbar] File picker error:', err)
    }
  }, [onFilesSelected, tauriFilters, useBrowserFileInput])

  return (
    // 右侧留出 ChatFab 的位置（FAB 绝对定位在输入框右下角，宽 32 + right 18）
    <div className="flex items-center justify-between pl-3 pr-14 pb-3 relative">
      {/* Left side: model + thinking level (merged into one menu) */}
      <div className={`flex items-center min-w-0 ${isCompact ? 'gap-1' : 'gap-2'}`}>
        {/* Model Selector — 工具栏第一个入口（桌面 + 移动端）
            移动端必须保证入口可见可点：给它 shrink-0 与最小宽度，
            让 Variant 先让位，而不是把模型入口挤成 0 宽 */}
        {onModelChange && (
          <div className={isCompact ? 'shrink-0 min-w-[6.5rem] max-w-[11rem]' : 'min-w-0 flex-1'}>
            <ModelSelector
              ref={modelSelectorRef}
              models={models}
              selectedModelKey={selectedModelKey}
              onSelect={onModelChange}
              isLoading={modelsLoading}
              position="top"
              trigger="toolbar"
              constrainToRef={inputContainerRef}
              variants={variants}
              selectedVariant={selectedVariant}
              onVariantChange={onVariantChange}
              onMenuOpenChange={onModelMenuOpenChange}
            />
          </div>
        )}

      </div>

      {/* Action Buttons — 发送 / 停止已移出，由右下角的 ChatFab 承担（同一图标形变）。
          这里只保留附件、上传等左侧动作。 */}
      <div className="flex items-center gap-1 shrink-0">
        <AnimatedPresence show={supportsAnyFile}>
          <>
            {/* 浏览器模式下的隐藏文件输入 */}
            {useBrowserFileInput && (
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptString}
                multiple
                className="hidden"
                onChange={e => {
                  onFilesSelected(Array.from(e.target.files ?? []))
                  e.currentTarget.value = ''
                }}
              />
            )}
            <IconButton aria-label={t('inputToolbar.attachFile')} disabled={controlsDisabled} onClick={handleFileClick}>
              <PaperclipIcon />
            </IconButton>
          </>
        </AnimatedPresence>
      </div>
    </div>
  )
}
