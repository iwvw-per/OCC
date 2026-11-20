import { forwardRef } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../utils/cn'

/**
 * Switch - 开关
 *
 * 基于 Radix Switch：自带 role="switch"、aria-checked 与键盘操作。
 *
 * 几何参考 Kumo（@cloudflare/kumo）的 Switch：
 *   轨道 36×18，滑块 18×18，完全撑满轨道高度，无内缩。
 *   位移 = 轨道宽 − 滑块宽 = 18px，所以两态左右留白都是 0，
 *   不存在「常态留 2px、激活留 4px」这种不对称。
 *
 * 与 Kumo 的差异（受本项目令牌约束）：
 *   - 圆角用本项目刻度（rounded-full / 圆角矩形），不引入 corner-shape: squircle
 *     （该属性仅 Chrome 139+ 支持，其它浏览器会回退成普通圆角）。
 *   - 颜色走主题令牌（accent-main-100），而非 Kumo 的固定 blue-500。
 *   - 两态都保留 1px 描边，只换颜色：此前激活态把描边去掉（ring-0），
 *     切换时边界突然消失，两态观感断裂。
 */
/**
 * 几何（外框尺寸；border-box）
 *
 *   轨道 36×20（含 1px 描边）→ 内净高 18
 *   滑块 16×16，四周留 2px：上下 (20-2*1-16)/2 = 1... 见下
 *
 * 用 border 而非 ring 表达描边，所以可放置区域 = 外框 − 2×border。
 * 滑块取 (内净高 − 2×inset)，保证上下左右留白严格相等：
 *   可用宽 34（36−2）、可用高 18（20−2）
 *   滑块 14×14 → 四周各留 2px
 *   位移 = 可用宽 − 滑块 − 2×inset = 34 − 14 − 4 = 16px
 *
 * 位移由这些常量算出，不写死 Tailwind 的 translate-x-* 网格值
 * （4px 网格凑不出这个数，会造成两态左右留白不等）。
 */
const TRACK_W = 36
const TRACK_H = 20
const BORDER = 1
const INSET = 2
const THUMB = TRACK_H - BORDER * 2 - INSET * 2
const THUMB_TRAVEL = TRACK_W - BORDER * 2 - THUMB - INSET * 2

export const Switch = forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'group/switch relative inline-flex shrink-0 cursor-pointer select-none items-center rounded-full',
        'border transition-colors duration-150 ease-out motion-reduce:transition-none',
        // ring 在本项目专属于「键盘焦点」（见 interaction.ts），描边一律用 border
        'focus-visible:outline focus-visible:outline-[1px] focus-visible:outline-accent-main-100 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-45',
        // 两态描边都保留，只换颜色
        'data-[state=checked]:border-accent-main-100 data-[state=checked]:bg-accent-main-100',
        'data-[state=checked]:hover:border-accent-main-200 data-[state=checked]:hover:bg-accent-main-200',
        // 关闭态用更深的轨道 + 更实的描边,避免在浅色卡片上「和背景糊在一起」
        'data-[state=unchecked]:border-border-300 data-[state=unchecked]:bg-bg-400',
        'data-[state=unchecked]:hover:border-border-300 data-[state=unchecked]:hover:bg-text-500/45',
        className,
      )}
      style={{ width: TRACK_W, height: TRACK_H, ...props.style }}
      data-switch-track
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-switch-thumb
        className={cn(
          'pointer-events-none block rounded-full bg-bg-000',
          // 双层阴影（Kumo 用法）：0.5px 边缘描边 + 1px 投影，让滑块从轨道上「浮起」
          'shadow-[0_0_1px_0.5px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.14)]',
          // 过渡的是独立属性 translate（见 index.css 的 [data-switch-thumb] 规则）。
          // 不能写 transition-transform：transform 与 translate 是两个独立属性，
          // 在部分引擎里 transition-transform 不会带动 translate，会变成瞬移。
          'transition-[translate] duration-150 ease-out motion-reduce:transition-none',
        )}
        style={
          {
            width: THUMB,
            height: THUMB,
            // 静止位：距可用区左上角各 INSET。用 margin 而非 translate，
            // 这样 CSS 里的 translate 只负责「位移量」，两者不互相干扰。
            marginLeft: INSET,
            '--switch-travel': `${THUMB_TRAVEL}px`,
          } as React.CSSProperties
        }
      />
    </SwitchPrimitive.Root>
  ),
)
Switch.displayName = 'Switch'
