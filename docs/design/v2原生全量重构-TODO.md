# OCC v2 全量重构 — 任务清单

> 目标：放弃 vibe-coded 架构，OpenCode v2 单一协议，单一数据源，净减代码、消除卡顿。
> 分支：`v2-native`　基线版本：v2.0.6
> 架构说明见 `docs/design/v2架构说明.md`。

## 阶段 0–2 — 协议与数据（已完成）

- [x] `createStore`（Zustand-free + Zod）作为唯一持久化原语
- [x] 移除 `serverStorage` 隐式「当前服务器」API，28 处调用点改为显式 serverId
- [x] 同步白名单收窄到 6 类；旧键一次性服务端清理
- [x] 增量推送（脏键 diff）+ SSE 感知轮询（60s / 15s）
- [x] 移除 v1 运行时：`clientFacade`(545 行)、v1 SSE 通道、54 处版本分支、`ensureApiVersion`
- [x] 健康检查只探 `/api/info`；`sdk.ts` 只保留 HTTP 基础设施
- [x] 所有 API 模块直连 `@opencode/client`，v2 缺失能力显式降级并注明

## 阶段 3 — 类型层（已完成）

- [x] 事件常量表删除 14 个从未触发的键
- [x] `PartDeltaPayload` 改为 v2 原生形状，store 索引在事件边界转换
- [x] vcs / skill / pty / worktree 类型移入 `types/domain`
- [x] 删除 43 个零引用导出；`types/api/index.ts` 去除已迁出类型的再导出

## 阶段 4 — 大组件拆分（已完成）

| 组件 | 前 | 后 | 拆出 |
|---|---|---|---|
| `App.tsx` | 1031 | 685 | `useAppShell` / `useAppKeybindings` / `usePaletteCommands` / `useAppDialogs` / `useMainSwipe` |
| `SidePanel.tsx` | 1321 | 796 | `useSessionSelection` / `useProjectGroups` / `useMissingSessionFetch` |
| `FolderRecentList.tsx` | 1514 | 1275 | `useFolderList`（展开派生 / 拖拽期收起 / 重排 hook） |
| `ChatPane.tsx` | 1352 | 1308 | `PaneInputDock`（欢迎层 / 提示 / 输入停靠） |
| `ChatArea.tsx` | 1292 | 1321 | `chatAreaTimeline`（行高估算 / 过程壳统计 / 行相等判定） |
| `InputBox.tsx` | 1941 | 1835 | `useMentionTrigger` / `useSlashTrigger` / `useLargePaste` / `inputMetrics` |

## 阶段 5 — UI 组件库（已完成基础）

- [x] `utils/controlStyles.ts`：控件尺寸 / 语义色 / 工具栏行词汇
- [x] `SettingsRow` / `SettingsInlineButton`：设置页「标题 + 说明 + 控件」与行内按钮
- [x] `offscreenRow`：列表行 `content-visibility: auto` 的统一样式
- 说明：剩余手写 `<button>` 多为一次性布局结构（拖拽行、图表控件），
  改造成本高于收益，保持原样；新增代码优先用 primitives。

## 阶段 6 — 性能（已完成）

- [x] **大 diff**：行计算抽成 `utils/diffLines`；>60k 字符推迟到空闲帧并显示加载态
- [x] **多 diff / 命令输出卡片**：`ContentBlock` 离屏不计算、不挂载（800px 预取）
- [x] **消息分页**：v2 消息适配分块执行（每 ~6ms 让出主线程）
- [x] **语法高亮**：进程级共享 LRU（html 200 / tokens 120）
- [x] **虚拟列表**：行相等判定不比较测量回写的 `size`，滚动不再整行重渲染
- [x] **长列表**：文件树节点 `content-visibility: auto`
- [x] **命令执行框 / 工具卡片**：过程壳高度估算独立成模块，展开/折叠不再回弹

## 阶段 7 — 收尾（已完成）

- [x] 统一日志入口：生产路径 `console.*` 收敛到 `logger`
- [x] 清理残留 v1 注释与过期说明
- [x] `docs/design/v2架构说明.md` 描述分层与硬约束
- [x] `npm run validate` 全绿并部署

## 后续可选（未排期）

- [ ] 超长会话（>2000 条消息）滚动帧率的真机实测与基线记录
- [ ] Shiki 语法高亮迁移到 OffscreenCanvas/Worker 直出像素（进一步降低主线程占用）
- [ ] `components/ui` 剩余手写按钮逐步替换为 primitives
