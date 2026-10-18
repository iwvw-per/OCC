# OCC v2 全量重构 — 任务清单

> 目标：放弃 vibe-coded 架构，OpenCode v2 单一协议，单一数据源，净减代码。
> 分支：`v2-native`　基线版本：v2.0.6

## 阶段 0–2（已完成）

- [x] **存储收敛** `createStore`（Zustand-free + Zod）作为唯一持久化原语
- [x] **显式绑定** 移除 `serverStorage` 隐式「当前服务器」API，28 处调用点改为显式 serverId
- [x] **同步白名单** 收窄到 6 类；旧键一次性服务端清理（`syncCleanup.ts`）
- [x] **增量推送** 脏键 diff + SSE 感知轮询（60s / 15s）
- [x] **移除 v1 运行时** `clientFacade`(545 行)、v1 SSE 通道、54 处版本分支、`ensureApiVersion`
- [x] **健康检查** 只探 `/api/info`；`sdk.ts` 只保留 HTTP 基础设施
- [x] **API 直连** 所有模块直接调用 `@opencode/client`，v2 缺失能力显式降级并注明

## 阶段 3 — 类型层收敛（已完成）

- [x] 3.1 盘点全部导出 vs 实际消费方（脚本 + 编译器双重校验）
- [x] 3.2 事件常量表删除 14 个从未触发的事件键
- [x] 3.3 `PartDeltaPayload` 改为 v2 原生形状（`assistantMessageID` + `ordinal`），
      store 索引在 `useGlobalEvents` 边界转换
- [x] 3.4 vcs / skill / pty / worktree 类型移入 `types/domain`，消费方直接引用
- [x] 3.5 删除 43 个零引用导出
- [x] 3.6 `types/api/index.ts` 去除已迁出类型的再导出
- [x] 3.7 验证：1592 passed / 20 skipped

> 保留项：`types/api/*` 中仍有少量「纯别名且有消费方」的类型（如 `SessionStatusMap`），
> 它们本身不是 v1 语义，属于轻量别名，保留比内联更易读。

## 阶段 4 — 大组件拆分

- [x] 4.1 `App.tsx` 1031 → **685** 行
      抽出 `useAppKeybindings` / `usePaletteCommands` / `useAppShell` / `useAppDialogs` / `useMainSwipe`
- [x] 4.2 `SidePanel.tsx` 1321 → **795** 行
      抽出 `useSessionSelection` / `useProjectGroups` / `useMissingSessionFetch`
- [x] 4.3 `FolderRecentList.tsx` 1514 → **1275** 行
      抽出 `useFolderList`（展开派生、拖拽期收起、通用重排 hook）
- [x] 4.4 `ChatPane.tsx` 1352 → **1308** 行
      抽出 `PaneInputDock`（欢迎层 / 提示气泡 / 输入停靠 / 半像素规避）
- [x] 4.5 `ChatArea.tsx` 抽出 `chatAreaTimeline`（行高估算、过程壳统计）
- [ ] 4.6 `InputBox.tsx`（1941 行）→ 编辑 / 斜杠 / 提及 / 粘贴
- [ ] 4.7 验证 + 部署 + 提交

## 阶段 5 — UI 组件库收敛

- [x] 5.1 盘点：`components/ui` 37 个原语，业务侧仍有 269 处手写 `<button>`
- [x] 5.2 `utils/controlStyles.ts`：控件尺寸 / 语义色 / 工具栏行词汇表
- [ ] 5.3 业务组件改用 primitives（设置面板、面板工具栏优先）
- [ ] 5.4 验证 + 部署 + 提交

## 阶段 6 — 性能（用户重点关注）

- [x] 6.1 **大 diff 卡顿**：行计算抽成纯函数 `utils/diffLines.ts`；
      超过 60k 字符推迟到空闲帧，先渲染加载态
- [x] 6.2 **多 diff 卡片**：`ContentBlock` 用 IntersectionObserver 把关，
      离屏块不计算行 diff、不做语法高亮、不挂载 DOM（800px 预取）
- [x] 6.3 **消息分页**：v2 消息适配改为分块执行（每 ~6ms 让出主线程）
- [x] 6.4 **语法高亮**：缓存改为进程级共享 LRU（html 200 / tokens 120）
- [x] 6.5 **命令执行框 / 工具卡片**：行高估算独立成模块，过程壳展开/折叠高度不再回弹
- [ ] 6.6 长输出（终端、bash 输出、超长工具结果）渲染节流复核
- [ ] 6.7 虚拟列表在超长会话（>2000 条）下的滚动帧率实测

## 阶段 7 — 收尾清理

- [ ] 7.1 删除死代码（未引用导出、v1 遗留注释、废弃工具函数）
- [ ] 7.2 统一日志与错误上报入口
- [ ] 7.3 文档：`docs/design/` 更新为 v2 架构说明
- [ ] 7.4 全量验证 + 部署 + 推送分支
