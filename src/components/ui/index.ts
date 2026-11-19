// ============================================
// UI 基础组件统一出口
//
// 约定：业务代码优先从这里导入，不要直接引具体文件路径。
// 新增基础组件时同时在此登记，避免出现「封装了但没人知道」的漂移。
// ============================================

// 动作
export { Button } from './Button'
export { IconButton } from './IconButton'
export { CopyButton } from './CopyButton'
export { MenuItem } from './MenuItem'
export { ContextMenuItem } from './ContextMenuItem'
export { ContextMenu } from './ContextMenu'
export type { ContextMenuPosition } from './ContextMenu'

// 表单
export { Input, Textarea } from './Input'
export { Label } from './Label'
export { Checkbox } from './Checkbox'
export { Switch } from './Switch'
export {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectGroup,
  SelectValue,
} from './Select'

// 反馈与状态
export { Spinner } from './Spinner'
export type { SpinnerSize, SpinnerTone, SpinnerVariant } from './Spinner'
export { LoadingState } from './LoadingState'
export { StatusDot } from './StatusDot'
export type { StatusTone } from './StatusDot'
export { Chip } from './Chip'
export type { ChipTone, ChipSize } from './Chip'
export { ProgressBar } from './ProgressBar'

// 披露（折叠行）
export { DisclosureRow } from './DisclosureRow'
export type { DisclosureRowSize, DisclosureLabelTone } from './DisclosureRow'

// 审批卡片
export { ApprovalCard } from './ApprovalCard'

// 导航与布局
export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs'
export { ScrollArea } from './ScrollArea'
export { SmoothHeight } from './SmoothHeight'
export { ResizablePanel } from './ResizablePanel'
export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from './Breadcrumb'
export type {
  BreadcrumbProps,
  BreadcrumbListProps,
  BreadcrumbItemProps,
  BreadcrumbLinkProps,
  BreadcrumbPageProps,
  BreadcrumbSeparatorProps,
  BreadcrumbEllipsisProps,
} from './Breadcrumb'

// 浮层
export { Dialog } from './Dialog'
export { ConfirmDialog } from './ConfirmDialog'
export { DropdownMenu } from './DropdownMenu'
export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose } from './Popover'
export {
  Tooltip,
  HintTooltip,
  NativeTooltip,
  ShortcutBadge,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
} from './Tooltip'
export { ModalShell } from './ModalShell'
export { AnimatedPresence, ExpandableSection } from './AnimatedPresence'

export { useModalAnimation } from '../../hooks/useModalAnimation'
