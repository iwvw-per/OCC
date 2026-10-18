# OCC v2 全量重构 — 任务清单

> 目标：放弃 vibe-coded 架构，OpenCode v2 单一协议，单一数据源，净减代码。
> 分支：`v2-native`　基线版本：v2.0.6

## 已完成

- [x] **阶段 0** 存储收敛：`createStore`（Zustand-free + Zod）作为唯一持久化原语
- [x] **阶段 0** 每服务器显式绑定，移除 `serverStorage` 隐式「当前服务器」API
- [x] **阶段 0** 同步白名单收窄到 6 类，旧键一次性服务端清理
- [x] **阶段 1** 增量推送（脏键 diff）+ SSE 感知轮询（60s / 15s）
- [x] **阶段 2** 移除 v1 运行时（`clientFacade`、v1 SSE、54 处版本分支、`ensureApiVersion`）
- [x] **阶段 2** 健康检查改探 `/api/info`；`sdk.ts` 只保留 HTTP 基础设施
- [x] 验证：`npm run validate` 1577 passed / 20 skipped；已部署 v2.0.6

## 阶段 3 — 类型层 v2 原生化

- [ ] 3.1 盘点：`src/types/api/*` 中「只是 v1 再导出」的类型 vs 真正被消费的类型
- [ ] 3.2 事件类型（`event.ts`，237 行）改为 v2 事件名，删除 v1 兼容联合
- [ ] 3.3 消息类型（`message.ts`）迁移到 `src/types/domain/message.ts` 的 v2 形状
- [ ] 3.4 会话/项目/文件/权限/MCP/PTY/Worktree 类型逐个迁移
- [ ] 3.5 `src/api/v2/adapt.ts` 逐函数下线，适配逻辑内联到调用点或删除
- [ ] 3.6 删除 `src/types/api/index.ts` 的 v1 兼容再导出
- [ ] 3.7 验证 + 部署 + 提交

## 阶段 4 — 大组件拆分

- [ ] 4.1 `src/App.tsx`（1031 行）→ 布局/启动/快捷键/全局事件分层
- [ ] 4.2 `src/features/chat/sidebar/SidePanel.tsx`（1321 行）→ 列表/头部/过滤器/空态
- [ ] 4.3 `src/features/chat/sidebar/FolderRecentList.tsx`（1514 行）→ 项目组/会话行/虚拟列表
- [ ] 4.4 `src/features/chat/ChatPane.tsx`（1352 行）→ 流/滚动/输入/附件
- [ ] 4.5 `src/features/chat/ChatArea.tsx`（1291 行）→ 消息渲染/轮次/工具/压缩
- [ ] 4.6 `src/features/chat/InputBox.tsx`（1941 行）→ 编辑/斜杠/提及/粘贴
- [ ] 4.7 验证 + 部署 + 提交

## 阶段 5 — UI 组件库收敛

- [ ] 5.1 盘点 `src/components/ui` 与业务组件内重复的按钮/输入/弹层样式
- [ ] 5.2 统一 `Button` / `Input` / `Select` / `Dialog` / `Tooltip` 的变体 API
- [ ] 5.3 业务组件改用 primitives，删除手写 className 组合
- [ ] 5.4 验证 + 部署 + 提交

## 阶段 6 — 收尾清理

- [ ] 6.1 删除死代码（未引用导出、v1 遗留注释、废弃工具函数）
- [ ] 6.2 统一日志与错误上报入口
- [ ] 6.3 文档：`docs/design/` 更新为 v2 架构说明
- [ ] 6.4 全量验证 + 部署 + 推送分支
