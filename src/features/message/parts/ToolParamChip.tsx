import { memo } from 'react'
import { getMaterialIconUrl } from '../../../utils/materialIcons'
import { cn } from '../../../utils/cn'

/** 看起来像文件路径（含分隔符或扩展名）时展示文件图标 */
function looksLikePath(text: string): boolean {
  return /[/\\]/.test(text) || /\.[a-z0-9]{1,8}$/i.test(text)
}

interface ToolParamChipProps {
  /** 工具的关键参数：文件路径、命令、查询词等 */
  text: string
  /**
   * 悬停提示文本。路径会先裁成相对会话目录的形式展示，
   * 完整绝对路径放这里，避免窄屏上把文件名挤掉。
   */
  titleText?: string
  /** 失败态用危险色 */
  error?: boolean
  className?: string
}

/**
 * ToolParamChip — 工具行内联的参数胶囊。
 *
 * 与左侧的动作名（Write / Bash / Edit）分工：动作名说做了什么，
 * 胶囊说作用在什么上（文件名、命令、查询词）。此前参数是裸的等宽文本，
 * 与动作名同权重，长参数会盖过动作名；收进胶囊后层级分明，也更容易扫读。
 *
 * 注意不要在这里用 reasoning-shimmer-text：胶囊嵌在扫光行内，
 * 继承来的 text-fill-color 会让 chip 文字透明，只剩底色。
 */
export const ToolParamChip = memo(function ToolParamChip({
  text,
  titleText,
  error = false,
  className,
}: ToolParamChipProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-0 items-center gap-1 rounded-sm px-1.5',
        'font-mono text-[length:var(--fs-xxs)] leading-none',
        // shimmer 的 text-fill-color 会继承，这里显式恢复为自身文字色
        '[-webkit-text-fill-color:currentColor]',
        'transition-colors duration-150',
        error ? 'bg-danger-100/10 text-danger-100' : 'bg-bg-200/70 text-text-400',
        className,
      )}
      title={titleText ?? text}
    >
      {looksLikePath(text) && <FileGlyph path={text} />}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  )
})

function FileGlyph({ path }: { path: string }) {
  return (
    <img
      src={getMaterialIconUrl(path, 'file')}
      alt=""
      width={11}
      height={11}
      className="block size-[11px] shrink-0"
      loading="lazy"
      decoding="async"
      onError={event => {
        event.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}
