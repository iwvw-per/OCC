// ============================================
// Tool Icons - powered by lucide-react
// 标准化的工具图标组件
// ============================================

import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  FileText,
  FilePenLine,
  Terminal,
  Search,
  Globe,
  Brain,
  Wrench,
  ListChecks,
  Loader,
  CircleHelp,
  Code2,
} from 'lucide-react'

interface IconProps {
  size?: number
  className?: string
}

const defaultSize = 16
// 不硬编码颜色：图标颜色由外层容器决定（工具类别多彩 / 运行中 accent / 失败 danger）。
// 硬编码 text-text-400 会直接作用在 SVG 上，优先级高于外层容器的颜色，导致多彩配色失效。
const defaultClassName = ''

function wrapTool(Icon: ComponentType<LucideProps>) {
  return function WrappedToolIcon({ size = defaultSize, className = defaultClassName, ...props }: IconProps) {
    return <Icon size={size} className={className} {...(props as LucideProps)} />
  }
}

export const FileReadIcon = wrapTool(FileText)
export const FileWriteIcon = wrapTool(FilePenLine)
export const TerminalIcon = wrapTool(Terminal)
export const SearchIcon = wrapTool(Search)
export const GlobeIcon = wrapTool(Globe)
export const BrainIcon = wrapTool(Brain)
export const WrenchIcon = wrapTool(Wrench)
export const ChecklistIcon = wrapTool(ListChecks)
/** 子 agent 任务：八角星（lucide Loader）。运行时的旋转由调用方控制。 */
export const TaskIcon = wrapTool(Loader)

export const QuestionIcon = wrapTool(CircleHelp)
/** Code Mode 的 execute：执行 JS 代码（区别于 shell 的系统命令），用代码括号图标 */
export const CodeIcon = wrapTool(Code2)
