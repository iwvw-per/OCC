# AGENTS.md

OpenCodeUI (OCC) —— OpenCode 第三方 Web / 桌面前端界面。基于 React 19 + TypeScript + Vite + TailwindCSS 构建，支持 Tauri 桌面端与 PWA。

## 常用命令与校验流程

- **启动开发服务器**：`npm run dev` (Vite, 前端默认端口 5173)
- **类型检查**：`npm run typecheck` (`tsc -b`)
- **运行单元测试**：`npm run test:run` (Vitest，单次运行)
- **代码规范检查**：`npm run lint` (ESLint)
- **完整流水线验证**：`npm run validate` (`typecheck` -> `lint` -> `test:run` -> `build`)
  - 修改重要接口、核心 store 或通信层代码后，必须保证 `npm run validate` 通过。
- **单测执行**：`npx vitest run path/to/target.test.ts`

## 仓库架构与文件域导引

修改或排查问题前，优先通过 `symbol_find` 定位符号，避免直接整文件阅读。

### 1. 通信与 API 适配层 (`src/api/`)
- `client.ts`：OpenCode 客户端初始化与单例管理。
- `events.ts` / `sse.ts`：SSE 事件流订阅、解析与重连机制。
- `session.ts`：会话生命周期调用（创建、删除、中断、恢复）。
- `v2/` 目录：OpenCode v2 原生 API 适配层（Session, Message, File, Agent, Worktree 等）。
- `turnSkeleton.ts`：轮次骨架与工具调用聚合还原逻辑。

### 2. 状态管理 (`src/store/`)
采用轻量模块化 Store 模式（基于事件驱动与自定义 hook）：
- `messageStore.ts`：会话消息流核心存储与更新。
- `activeSessionStore.ts`：当前激活会话、运行状态跟踪。
- `serverStore.ts`：远程/本地服务器连接配置。
- `layoutStore.ts`：UI 布局、侧边栏折叠与面板大小。

### 3. 业务特征模块 (`src/features/`)
- `chat/`：聊天主界面，包含虚拟列表、流式消息渲染与滚动控制：
  - `ChatArea.tsx`：主聊天区域容器。
  - `virtual/useAutoScroll.ts`：自动滚动触底与粘底逻辑。
  - `chatPageModel.ts`：会话滚动锚点恢复与计算。
- `message/`：单条消息渲染、Markdown 语法高亮、工具调用卡片（ToolCall）。
- `attachment/`：文件附件、图片粘贴与预览。
- `sessions/`：会话列表、归档管理与历史记录。
- `workStatus/`：任务执行状态指示器、吞吐量监控与插件面板。

### 4. 关键通用 Hooks (`src/hooks/`)
- `sessionTurnStats.ts` / `sessionStatsCompute.ts`：会话耗时、Token 用量与工具执行统计。
- `useDynamicVirtualScroll.ts`：动态高度虚拟滚动实现。
- `useSessionManager.ts`：会话切换、数据合并与协调。

### 5. 独立辅助项目
- `src-router/`：Rust 编写的动态网关服务（基于 Caddy/Axum），不参与前端 Vite 构建，仅在特定 Docker 容器与网关部署中使用。
- `src-tauri/`：Tauri 桌面端客户端配置与 Rust 原生绑定。

## 开发与调试规范

1. **定位优先**：
   - 定位函数、组件或类型定义时，优先使用 `symbol_find` 获取行号。
   - 读取大文件（如 `ChatArea.tsx`）严禁全量整读，必须配合 `offset` 与 `limit` 针对性阅读。
2. **测试驱动与测试覆盖**：
   - 业务逻辑文件（`*.ts`）必须伴随同目录的单元测试（`*.test.ts`）。
   - 修改 bug 时，优先编写或修改针对性的单元测试以重现并验证修复。
3. **性能感知**：
   - 聊天界面涉及高频流式渲染，避免在 `ChatArea` 渲染循环中引入深拷贝或重计算。
