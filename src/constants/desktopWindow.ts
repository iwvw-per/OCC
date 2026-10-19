// ============================================
// Desktop window constants
// ============================================

export const DESKTOP_TITLEBAR_HEIGHT = 44
export const DESKTOP_TITLEBAR_Z_INDEX = 220
export const DESKTOP_FULLSCREEN_LAYER_Z_INDEX = 320
export const DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH = 72
/**
 * Windows 全高侧栏收起（rail）时的最小宽度：顶部工具栏按钮部分的宽度。
 * 收起时工具栏仅保留开关按钮（IconButton md，32px），左右各留 pl-2/pr-2（8px）与下方图标
 * 对齐、与边框留距，因此最小宽度 = 8 + 32 + 8 = 48px，保证按钮完整显示且不贴边。
 */
export const DESKTOP_SIDEBAR_RAIL_WIDTH = 8 + 32 + 8
/**
 * 侧栏拖拽调节宽度的下限：必须容纳顶栏那一排导航按钮，否则按钮被挤压。
 *
 * 网页端与桌面端共用同一排控件（DesktopNavControls），因此下限也必须一致：
 * 一端 160、另一端 228 会让「同样的按钮放下/放不下」在不同端表现不同。
 * 6×IconButton md(32px) + 5×gap(4px) + pl-2(8px) + pr-2(8px) = 228px。
 */
export const DESKTOP_SIDEBAR_MIN_WIDTH = 6 * 32 + 5 * 4 + 8 + 8
