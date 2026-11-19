# AI 对话组件视觉原语

最后更新：2026-09-20

本文件约束 AI 对话（消息流、工具调用、审批交互）的视觉实现方式。目标是把此前
散落在 `features/message/` 与 `features/chat/` 里的多套自绘控件收敛成少量原语，
让同一种语义在消息流各处看起来是同一个东西。

参考来源：https://www.beautifului.dev/ 的 AI-native primitives（Thinking / Tool
Chips / Task Rows / Approval Card / Loading State）。

## 一、原语清单

全部位于 `src/components/ui/`，从统一出口导入。

| 组件 | 语义 | 替代掉的旧实现 |
|---|---|---|
| `Spinner` | 加载指示（ring / pixel / dots / orbit / grid-orbit） | 6 处手写 `border-2 border-* animate-spin` 圆圈 |
| `LoadingState` | 大块加载（带已耗时） | 会话/历史加载的裸 spinner |
| `StatusDot` | running / completed / failed / pending | 各处手写 `w-2 h-2 rounded-full bg-*` |
| `Chip` | 小面积状态标记 | `bg-*-100/20 text-*-100 px-1.5 py-0.5 rounded-xs` |
| `ProgressBar` | 行内细进度条 | 待办只有 `3/8` 文字计数，没有比例 |
| `DisclosureRow` | 可折叠行 header | 过程壳 / 思考 / 工具行 / 子任务 / 工具组五套 header |
| `ApprovalCard` | 需用户决策的卡片 | 权限确认、提问的裸按钮行 |

### Spinner

```tsx
<Spinner size="sm" tone="accent" />                 // 12px 圆环
<Spinner variant="pixel" size="lg" tone="accent" /> // 3x3 网格（对角波，过程壳「已处理」）
<Spinner variant="drive" size="sm" tone="muted" />  // 3x3 网格（Drive 右行波，思考「思考中」）
<Spinner variant="dots" tone="muted" />             // 三点
<Spinner variant="orbit" tone="muted" />            // 轨道
```

`size` 取 `xs|sm|md|lg`（10/12/14/20px），`tone` 取 `muted|accent|current`，
`variant` 取 `ring|pixel|dots|orbit|grid-orbit|drive`。

两种网格变体刻意区分，避免「思考中」与「已处理」的图标撞车：

- `pixel`：对角波，延迟按 `i%3 + i/3` 以 120ms 步进，1.4s 周期。用于过程壳
  「已处理」等。
- `drive`：Drive 右行波浪，延迟按「列 + 到中行的距离」递增，形成向左凸的箭头
  一道接一道向右推进；650ms 的周期短于整轮扫过，常有两道波前同时在飞。用于
  思考「思考中」。

各网格变体走 `src/index.css` 的 `loader-pixel-cell` / `loader-drive-cell` /
`loader-dot-cell` / `loader-orbit-ring` / `loader-grid-orbit-cell` 类，共用同一套
节奏常量，避免同一屏出现多种转速。`prefers-reduced-motion` 下统一降级为静态。

不要再用 `border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin`
这类手写圆圈 —— 尺寸、颜色、圆角各写一遍是此前不一致的根源。

`SpinnerIcon`（`components/Icons.tsx`）仍然存在，它是 lucide 图标的通用再导出，
带 `size` 与 `className` 直通；新代码写对话组件时用 `Spinner`，语义更明确。

### LoadingState

```tsx
<LoadingState label={t('chatArea.loadingSession')} />
<LoadingState label={t('chatArea.loadingHistory')} size="sm" layout="row" showElapsed={false} />
```

默认从挂载时刻起显示已耗时（`0.4s` / `1.2s` / `12s`）。挂载时刻取自
`useState(() => Date.now())`，不在渲染期直接读时钟（违反 React 纯函数约束）。

### StatusDot / Chip

```tsx
<StatusDot tone="running" />              // 自动 pulse，只有 running 才动
<Chip tone="success">已完成</Chip>
```

状态色只允许四档，不要再引入 `info-100` / `accent-secondary-100` 表达状态：

| 状态 | 色 |
|---|---|
| running / active | `accent-main-100` |
| completed | `text-400` 或 `success-100` |
| failed / error | `danger-100` |
| pending / idle | `text-500` |

### DisclosureRow

五套 header 的统一骨架。高度按消息流既有行高取值：

| size | 高度 | 用在哪 |
|---|---|---|
| `sm` | `py-1`（约 28px） | 思考、过程壳、描述型工具行、子任务行、工具组 |
| `md` | `h-8`（32px） | 卡片头（todo、ContentBlock） |
| `lg` | `h-9`（36px） | 时间线工具行 |

```tsx
<DisclosureRow
  ref={headerRef}
  expanded={expanded}
  onClick={toggle}
  size="sm"
  labelTone={isActive ? 'active' : isError ? 'error' : 'idle'}
  icon={<SomeIcon size={14} />}
  label="执行了 3 条命令"
  meta={<span className="tabular-nums">1.2s</span>}
/>
```

关键属性：

- `labelTone`：`idle`（默认，hover 提亮）/ `active`（扫光）/ `error`（危险色）。
  不要在各调用点自己拼 `reasoning-shimmer-text` 与 `text-danger-100`。
- `inset`：默认 `true`，套用消息流的负 margin 内边距（`interactive.contentRow`）。
  卡片内 header 传 `false`，由卡片自身提供 `px-3`。
- `growLabel`：默认 `true`，标签占满剩余空间、meta 靠右。行内标签后要紧跟
  chevron 的场景（如过程壳的时长）传 `false`。
- `truncateLabel`：默认 `true`。标签内部需要自行测量/换行的（如思考摘要）
  传 `false`。
- `showChevron` / `reserveChevronSpace`：隐藏 chevron 但保留占位，避免多行
  纵向对齐抖动。

### ApprovalCard

```tsx
<ApprovalCard
  header={<><ShieldIcon size={14} /> <span>bash</span></>}
  footer={<><button>允许</button><button>拒绝</button></>}
>
  内容
</ApprovalCard>
```

结构与 `ContentBlock` 同源（`rounded-md` + border + header 条），让审批类交互
与工具结果在消息流里读起来是同一种东西。header 固定 32px 高，footer 与内容
之间用分隔线隔开。

## 二、工具组与过程壳的折叠态

`ToolGroup` 在描述型模式下，header 已经用一句话概括了「做了什么」。
折叠时再补一条 `ToolIconStrip`（最多 6 个工具图标 + `+N`），回答「用了哪些工具」；
非描述型模式则由 `meta` 展示图标条。图标与文字不重复：文字说动作，图标说工具种类。
图标的颜色就是状态：运行中/待命用 accent 色（task 图标同步 `animate-spin` 旋转、
静止时停转），失败用 danger 红，完成保持静默灰。图标条用 `align-middle` 与文字
垂直居中，不依赖基线偏移。

### 图标 + 单行文本的光学居中

多数 UI 字体的 ascent 明显大于 descent,行盒中心比字形墨迹中心略低。
flex 的 `items-center` 按行盒居中,因此「图标 + 单行文本」看起来
文字偏上约 0.5~0.8px。给该单行文本块加 `optical-center`（`index.css`，内部是
`text-box: trim-both`）把行盒裁到字形上下缘，墨迹落到行盒中心，与图标同心。

只用于单行、且与图标同排的文本块（侧栏会话/项目名、工具名、步骤数等）。正文
多行文本不要用：裁掉首行上方与末行下方的半行距会改变段落高度。不支持该属性的
浏览器（旧 WebView2 / WebKitGTK）直接忽略，退回原状，不会报错。

注意：消息流的工具名、步骤数等行此前专门用 `items-baseline` / `items-center`
调过对齐（见提交 `50a30ced`、`ed9c605c`），不要在这些地方叠加 `optical-center`，
以免覆盖既有约定。
展开后图标条消失，由完整的时间线工具行接管。

`ProcessCollapseBlock` 折叠时在 header 右侧显示「N 步」与思考段数，
由 `ChatArea` 从壳内消息的 parts 统计后传入。展开后不再显示（内容已在眼前）。

`TodoRenderer` 的 header 展示 `ProgressBar` + `completed/total` + 百分比。
百分比与 `InputFooter` 的 `CircularProgress` 同源（都是 `completed/total`），
环形用于独立指标面板，条形用于行内 header。

`InlineQuestion` 在问题数 > 1 时启用分页：header 显示 `1 / 3` 与进度点，
footer 的提交按钮换成「上一个 / 下一个」，最后一页才出现「提交」，
并显示「已答 N/M」。

## 三、运行态与折叠的三个约定

### 忙碌态至少保持 300ms

`useMinDurationActive(active, 300)`：工具跑得极快时，扫光/脉冲只闪一帧就消失，
看起来像界面在抖。与其让它闪，不如让它多留一会儿。工具行用它控制扫光与图标旋转；
计时读数仍用真实的 `isActive`，不参与延迟。

上限 5 分钟强制结束，避免上游没回结束事件时永远在转。

### 折叠内容必须 inert

`MessageExpandPanel` 在 `open=false` 时给内层加 `inert`。收起后内容仍留在 DOM
（unmount 有 320ms 延迟，`keepMounted` 场景更是常驻），不加 `inert` 时键盘用户
Tab 会进入高度为 0 的隐藏内容。

`aria-hidden` 单独用不够：它管朗读，管不住可聚焦性；用 `aria-hidden` 包住可聚焦
后代本身就是无障碍缺陷。

### 时间戳不要每个组件各起一个定时器

`useNow` 现在按 interval 分组共享定时器：同 interval 的订阅者共用一个
`setInterval` 和同一个 `now`。此前一条消息里 5 个运行中的工具行就是 5 个定时器
各自唤醒、各自触发重渲染。

## 四、折叠态摘要要跳过结构行

思维链常以围栏代码块、分隔线或空行开头。若直接取第一行，摘要会变成 ``` 、---
这类无信息量的符号。`firstMeaningfulLine` 跳过这些行，取第一条真正的文字行。

注意它返回的是**原始行**（保留 markdown 标记）—— 折叠预览仍走 `MarkdownRenderer`，
标记由渲染器处理，这个函数只负责选中哪一行。

## 五、硬性约定

1. **不要手写 spinner 圆圈**：用 `Spinner`。
2. **不要给 hover / 选中态加边框**：用底色 + 文字色，见
   `docs/standards/前端组件与样式约定.md` 的交互态一节。
3. **状态色只用四档**：见上表。
4. **折叠行统一走 `DisclosureRow`**：新增折叠交互时不要再写裸 `<button>` +
   chevron + hover 的三件套。
5. **审批卡片用 `ApprovalCard`**：不要再拼裸按钮行。
6. **不要在扫光容器里嵌 chip**：`reasoning-shimmer-text` 的
   `-webkit-text-fill-color: transparent` 会继承，把 chip 文字变透明。
   `Chip` / `ToolParamChip` 已内置重置，自己写容器时也要显式
   `[-webkit-text-fill-color:currentColor]`。

## 六、验证

```bash
npm run typecheck && npm run lint && npx vitest run src/components/ui src/features/message
```

原语单测在 `src/components/ui/chatPrimitives.test.tsx`，锁的是语义与结构
（`aria-expanded`、`aria-busy`、`aria-hidden`、tone 映射），不断言具体类名，
除非是回归保护。运行态与摘要逻辑的单测分别在
`src/hooks/useNow.test.ts`、`src/features/message/parts/reasoningSummary.test.ts`。
