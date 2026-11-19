/* eslint-disable react-refresh/only-export-components -- Icon re-exports barrel file */
// Icon components - powered by lucide-react
// Re-exports with project defaults (size=16, aria-hidden)
import type { SVGProps, ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  SquarePen,
  Hand,
  Keyboard,
  Check,
  Send,
  Plus,
  GraduationCap,
  Settings,
  Sun,
  Moon,
  Monitor,
  PanelLeft,
  PanelRight,
  PanelBottom,
  Image,
  Copy,
  Code2,
  Brain,
  ExternalLink,
  X,
  Sparkles,
  Undo2,
  Redo2,
  Terminal,
  File,
  Folder,
  FolderOpen,
  FolderMinus,
  Search,
  Pencil,
  Trash2,
  CornerDownLeft,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  Share,
  Link,
  Globe,
  MessageSquare,
  ArrowUp,
  ArrowDown,
  Clock,
  Circle,
  CircleAlert,
  RefreshCcw,
  Cpu,
  Package,
  Server,
  DollarSign,
  Lightbulb,
  Users,
  GitCommitHorizontal,
  GitBranch,
  Split,
  Plug,
  KeyRound,
  Wifi,
  WifiOff,
  Bell,
  Download,
  Pin,
  Square,
  LoaderCircle,
  CircleHelp,
  Slash,
  FileDiff,
  Vibrate,
  Waypoints,
  GitCompare,
  ListTodo,
  Layers,
  Minus,
  Paperclip,
  FastForward,
  Volume2,
  VolumeX,
  Play,
  Upload,
  Shield,
  Columns2,
  Rows2,
  GripVertical,
  AppWindow,
  ZoomIn,
  ZoomOut,
  ArrowUpNarrowWide,
  ArrowDownNarrowWide,
  CalendarPlus,
  ListChecks,
  MoreHorizontal,
  Archive,
  ChartNoAxesColumn,
  Gauge,
  Timer,
  Database,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

// ============================================
// Wrapper: apply project defaults (size=16, aria-hidden)
// ============================================

function wrap(Icon: ComponentType<LucideProps>) {
  const Wrapped = ({ size = 16, ...props }: IconProps) => (
    <Icon size={size} aria-hidden="true" {...(props as LucideProps)} />
  )
  return Wrapped
}

// ============================================
// Lucide-backed icons
// ============================================

export const ChevronDownIcon = wrap(ChevronDown)
export const ChevronUpIcon = wrap(ChevronUp)
export const ChevronLeftIcon = wrap(ChevronLeft)
export const ChevronRightIcon = wrap(ChevronRight)
export const NewChatIcon = wrap(SquarePen)
export const HandIcon = wrap(Hand)
export const KeyboardIcon = wrap(Keyboard)
export const CheckIcon = wrap(Check)
export const SendIcon = wrap(Send)
export const PlusIcon = wrap(Plus)
export const TeachIcon = wrap(GraduationCap)
export const SettingsIcon = wrap(Settings)
export const SunIcon = wrap(Sun)
export const MoonIcon = wrap(Moon)
export const SystemIcon = wrap(Monitor)
export const SidebarIcon = wrap(PanelLeft)
export const PanelRightIcon = wrap(PanelRight)
export const PanelBottomIcon = wrap(PanelBottom)
export const ImageIcon = wrap(Image)
export const CopyIcon = wrap(Copy)
export const CodeIcon = wrap(Code2)
export const AgentIcon = wrap(Brain)
export const ExpandIcon = wrap(ExternalLink)
export const CloseIcon = wrap(X)
export const ThinkingIcon = wrap(Sparkles)
export const UndoIcon = wrap(Undo2)
export const RedoIcon = wrap(Redo2)
export const TerminalIcon = wrap(Terminal)
export const FileIcon = wrap(File)
export const FolderIcon = wrap(Folder)
export const FolderOpenIcon = wrap(FolderOpen)
export const FolderMinusIcon = wrap(FolderMinus)
export const SearchIcon = wrap(Search)
export const PencilIcon = wrap(Pencil)
export const TrashIcon = wrap(Trash2)
export const ReturnIcon = wrap(CornerDownLeft)
export const EyeIcon = wrap(Eye)
export const EyeOffIcon = wrap(EyeOff)
export const MaximizeIcon = wrap(Maximize)
export const MinimizeIcon = wrap(Minimize)
export const ShareIcon = wrap(Share)
export const LinkIcon = wrap(Link)
export const ExternalLinkIcon = wrap(ExternalLink)
export const GlobeIcon = wrap(Globe)
export const MessageSquareIcon = wrap(MessageSquare)
export const ArrowUpIcon = wrap(ArrowUp)
export const ArrowDownIcon = wrap(ArrowDown)
export const ClockIcon = wrap(Clock)
export const CircleIcon = wrap(Circle)
export const AlertCircleIcon = wrap(CircleAlert)
export const RetryIcon = wrap(RefreshCcw)
export const ZoomInIcon = wrap(ZoomIn)
export const ZoomOutIcon = wrap(ZoomOut)
export const CpuIcon = wrap(Cpu)
export const PackageIcon = wrap(Package)
export const ServerIcon = wrap(Server)
export const DollarSignIcon = wrap(DollarSign)
export const LightbulbIcon = wrap(Lightbulb)
export const UsersIcon = wrap(Users)
export const GitCommitIcon = wrap(GitCommitHorizontal)
export const GitBranchIcon = wrap(GitBranch)
export const SplitIcon = wrap(Split)
export const PlugIcon = wrap(Plug)
export const KeyIcon = wrap(KeyRound)
export const WifiIcon = wrap(Wifi)
export const WifiOffIcon = wrap(WifiOff)
export const BellIcon = wrap(Bell)
export const DownloadIcon = wrap(Download)
export const PinIcon = wrap(Pin)
export const VibrateIcon = wrap(Vibrate)

// Aliases
export const ComposeIcon = wrap(SquarePen)
export const CogIcon = wrap(Settings)

/**
 * 绿色空心圆 + 对勾：用于「子任务已完成」的状态图标。
 * 描边风格（圆不填充），与运行中的旋转图标形成「进行/完成」的对比。
 */
export function TaskDoneIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.1 8.2l1.9 1.9 3.9-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ============================================
// Brand icons - 「打开项目目录」的目标程序图标
//
// 这三个是应用程序的品牌图标（资源管理器 / VS Code / 终端），lucide 无对应，
// 用内联 SVG 保留各自品牌色。仅用于「选择打开方式」语境，不随主题变色。
//
// 三者的原始绘制边界差异很大（VS Code 撑满 24x24，文件夹只有约 19x16），
// 同一 width 下视觉大小会明显不齐。这里用 transform 把内容统一缩放到居中约
// 19x19 的视觉框内，保证并排/切换时大小一致。
// ============================================

/** 文件资源管理器：双色文件夹。 */
export function FileManagerIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <g transform="translate(0.5 1.9) scale(0.958)">
        <path fill="#FFB64E" d="M2.5 5.8A1.8 1.8 0 0 1 4.3 4h4.5c.55 0 1.07.25 1.42.68L11.1 6h8.6a1.8 1.8 0 0 1 1.8 1.8v1.4H2.5z" />
        <path fill="#FFD37A" d="M2.5 9.2h19v8.9A1.9 1.9 0 0 1 19.6 20H4.4a1.9 1.9 0 0 1-1.9-1.9z" />
      </g>
    </svg>
  )
}

/** VS Code 品牌标识。 */
export function VscodeIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <g transform="translate(2.4 2.4) scale(0.8)">
        <path
          fill="#007ACC"
          d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448z"
        />
      </g>
    </svg>
  )
}

/** 终端：深色圆角方块 + 提示符。描边保证在深色/浅色背景上都可见。 */
export function TerminalAppIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <g transform="translate(1.14 1.5) scale(0.905)">
        <rect x="1.5" y="2" width="21" height="20" rx="2.6" fill="#0C0C0C" stroke="#9AA0A6" strokeWidth="1" />
        <path
          d="M6.4 8.2 10.2 12l-3.8 3.8"
          fill="none"
          stroke="#F2F2F2"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M12 16.1h5.4" fill="none" stroke="#F2F2F2" strokeWidth="1.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}

// ============================================
// Icons with custom defaults (lucide-backed)
// ============================================

export const StopIcon = ({ size = 16, ...props }: IconProps) => (
  <Square size={size} fill="currentColor" strokeWidth={0} aria-hidden="true" {...(props as LucideProps)} />
)

export const SquareIcon = wrap(Square)

export const SpinnerIcon = wrap(LoaderCircle)
export const QuestionIcon = wrap(CircleHelp)
export const PathAutoIcon = wrap(Sun)
export const PathUnixIcon = wrap(Slash)

export const PathWindowsIcon = ({ size = 16, style, ...props }: IconProps) => (
  <Slash size={size} aria-hidden="true" style={{ transform: 'scaleX(-1)', ...style }} {...(props as LucideProps)} />
)

export const PatchIcon = wrap(FileDiff)
export const GitWorktreeIcon = wrap(Waypoints)
export const GitDiffIcon = wrap(GitCompare)
export const PermissionListIcon = wrap(ListTodo)
export const LayersIcon = wrap(Layers)
export const StatsIcon = wrap(ChartNoAxesColumn)
export const GaugeIcon = wrap(Gauge)
export const TimerIcon = wrap(Timer)
export const DatabaseIcon = wrap(Database)
export const MinusIcon = wrap(Minus)
export const PaperclipIcon = wrap(Paperclip)
export const FastForwardIcon = wrap(FastForward)
export const VolumeIcon = wrap(Volume2)
export const VolumeOffIcon = wrap(VolumeX)
export const PlayIcon = wrap(Play)
export const UploadIcon = wrap(Upload)
export const ShieldIcon = wrap(Shield)
export const SplitHorizontalIcon = wrap(Columns2)
export const SplitVerticalIcon = wrap(Rows2)
export const GripVerticalIcon = wrap(GripVertical)
export const AppWindowIcon = wrap(AppWindow)
export const SortIcon = wrap(ArrowUpNarrowWide)
export const SortDescIcon = wrap(ArrowDownNarrowWide)
export const CalendarPlusIcon = wrap(CalendarPlus)
export const ManageSessionsIcon = wrap(ListChecks)
export const CollapseAllIcon = wrap(ChevronsDownUp)
export const ExpandAllIcon = wrap(ChevronsUpDown)
export const MenuDotsIcon = wrap(MoreHorizontal)
export const ArchiveIcon = wrap(Archive)
