/**
 * 全局浮层层级(z-index)刻度。
 *
 * 为什么要集中:这些弹层几乎都 portal 到 `document.body`,于是「谁在上面」只由
 * z-index 决定(DOM 顺序仅在 z-index 相同时才起作用)。此前各处硬编码且互相矛盾:
 *
 *   - `Dialog` / `CommandPalette`   : 300
 *   - `Select` / `Popover`          : 200   ← 低于对话框
 *   - `DropdownMenu`                : 100   ← 更低
 *   - 配置编辑器内的下拉             : 400
 *
 * 后果:任何开在对话框里的下拉框都会被对话框盖住(下拉菜单显示在下一段内容的
 * 后面),而配置编辑器里的下拉却正常 —— 同一产品里两套标准。
 *
 * 统一后的顺序(从低到高):
 *   面板 < 对话框 < 弹层(下拉/浮层) < 上下文菜单 < 拖拽层
 *
 * ⚠️ 弹层必须**高于对话框**:对话框内的 Select/Popover/DropdownMenu 是常见用法,
 * 低于就会重演本 bug。反向的「从弹层里再开对话框」极少见,且上下文菜单点完即关。
 */

/** 应用内常驻面板(底部/右侧抽屉等) */
export const LAYER_PANEL = 100

/** 模态对话框、命令面板 */
export const LAYER_DIALOG = 300

/** 下拉框、浮层(Popover)、下拉菜单 —— 需要盖在对话框之上 */
export const LAYER_POPUP = 400

/** 提示气泡:压在弹层之上,避免被下拉菜单遮住 */
export const LAYER_TOOLTIP = 500

/** 右键/长按菜单:最上层的交互浮层(点完即关) */
export const LAYER_CONTEXT_MENU = 9999

/** 内部拖拽指示层:纯视觉,压在最上面 */
export const LAYER_DRAG = 10000
