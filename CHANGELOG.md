## v0.3.0 (2026-09-26)

本次为 **DSH 0.1.7-rc.2 兼容性适配**，同时修复了仓库里长期存在的构建与发布问题。

### 兼容性（必须升级 DSH 到 0.1.7-rc.2 才能使用本版本）

- **修复「会话管理」「对话管理」点击无反应**：`@deepseek-ai/dsh-client-ui-primitives` 已移除 `IconTrashOutline16` 等 `<名字>16` 系列导出（命名改为 `<名字>Regular`(1px) / `<名字>Medium`(1.3px)，尺寸由 `size` 属性决定）。渲染删除按钮时 `createElement(undefined)` 触发 React error #130，被 DSH 记为 `slot entry crashed` 后界面保持原样，因此表现为「点击没反应」。已改用 `IconTrashOutlineRegular`（[#23](https://github.com/dream12347/dsh-session-manager/issues/23)）
- **修复客户端条目无法加载**：`dsh.client.inject` 原先声明了已不存在的 `@deepseek-ai/dsh-client-runtime`。现按「服务/slot 的实际提供方」重写为 7 项，并区分了**客户端插件**与**库**——`dsh-client-ui-slots` / `dsh-client-ui-primitives` 是无 `dsh` 块的库（会被内联），不应出现在 `inject` 中（[#22](https://github.com/dream12347/dsh-session-manager/issues/22)）
- **修复启动守卫判定 BROKEN 并自动禁用**：移除客户端 bundle 中两段顶层的 DOM IIFE（向 `document.head` 注入导航图标样式 + `MutationObserver(document.body)`）。该逻辑早已在源码中改为正规 slot 实现，但仓库里提交的 `lib/client.js` 自 v0.2.0 起未重建，一直带着这两段旧代码（[#15](https://github.com/dream12347/dsh-session-manager/issues/15)）

### 修复（构建与发布）

- **`devDependencies` 不再指向作者本机**：原为 `link:C:/Users/mengxiang/AppData/...`，在任何其他机器上都无法安装。现改为 DSH 0.1.7-rc.2 的真实版本号，`pnpm install && pnpm build` 可复现
- **重建 `lib/`**：产物此前与 `src/` 脱节（仍引用旧图标名与旧 DOM hack）。本次一并重建 host 与 client 两半
- `peerDependencies`：移除已不存在的 `@deepseek-ai/dsh-agent-presets`（改为 `dsh-agent-preset-registry`），删除从未被引用的 `js-yaml`

### 适配（host 半）

- **会话元数据读取**：`sessionPersistence.list()` 现在返回 `SessionPersistenceSnapshot`，元数据位于 `.header` 下（`.id` / `.cwd` / `.version` 不再直接暴露）
- **`locate()` 已移出 `SessionPersistence` 契约**（现在只暴露 `create`/`open`/`flush`/`stat`/`list`）。它仅作为 JSONL 后端的诊断钩子存在，且接收 `SessionHeader` 而非快照。现以窄化转型 + **特性检测**访问：后端没有该方法时降级为「只归档、不移动文件」并记录警告，而不是让每次删除都返回 500
- **归档/取消归档改用官方 API** `workspaceRegistry.archiveSession()` / `unarchiveSession()`，并删除对私有 `state` 字段的直接写入（新版的官方实现会在一次 `setState` 中同时更新持久域与缓存，且域结构已新增 `initialized` / `pendingMutation` / `pinnedSessionIds`）
- **压缩阈值不再读写预设文件**：新版预设是内联的 `@deepseek-ai/dsh-agent-preset` bundle 行，`agentPresets.resolve()` 只返回 `{ id, name?, description?, order?, broken? }`，**没有 `path` / `trust`**。存储域成为唯一真源，GET 响应新增 `source` 字段（`saved` / `default`）以便界面区分「已保存」与「插件默认值」。

### 行为变化（请留意）

- **压缩阈值**：直接写在你自己的预设里的 `thresholdRatio`，在插件里首次保存之前不再被镜像显示（预设文件模型已不存在）。插件保存过的值不受影响，仍然全量生效并跨重启保留
- **彻底删除（purge）**：新增活会话保护——若该会话仍处于活跃状态，不再无条件删除其原目录。原实现会删掉删除动作之后新写入的日志

### 适配（client 半）

- 类型与 API 迁移：`@deepseek-ai/dsh-client-runtime`（包已删除）中的 `SessionListState` / `SessionSummary` / `ISessions` / `SessionTarget` 改由 `@deepseek-ai/dsh-api-session-controller/client` 提供，`SlotRegistry` 改由 `@deepseek-ai/dsh-client-ui-renderer/client` 提供，`IWorkspaces` / `WorkspaceSnapshot` / `WorkspaceId` 改由 `@deepseek-ai/dsh-api-workspace-controller/client` 提供，`SessionId` 改由 `@deepseek-ai/dsh-api-remotes/client` 提供
- 已删除的 `ConnectionHandle.api` 门面（`IApiClient`）拆解为官方客户端服务：`sessions`（`ISessions`）/ `workspaces`（`IWorkspaces`）。插件自身的 `/dsh-session-manager/*` 路由位于 `/api` 鉴权栅栏之外，浏览器侧仍用原生 `fetch`，无需改动
- 会话内导航由 `sessions.open(...)` 改为 `ctx.uiWorkspace.openSession(...)`（`SessionTarget`）
- **统计改读官方 `sessionStats` 投影**：旧的 `session.history` RPC 已被 `session.page` 取代（需先经 `session.follow` 取 `throughSeq`，属分页式重写），改为直接读已加载的列表快照 `projectionsBySession[id].values.sessionStats`，无 RPC、无加载态
- **每会话状态改用官方 `useSessionStatus()`**：不再有私有的 `pendingInteraction` / `completed` 字段
- 抽屉的工作区列表由「5 秒轮询的 RPC 快照」改为官方实时 Controller 快照；轮询仅保留用于刷新回收站

### 行为变化（client 半）

- **统计弹窗字段变化**：现在显示 轮次 / 步骤 / 模型耗时 / 工具耗时 / 首 token 延迟与步数 / 解码耗时与输出 token。**不再显示** 用户消息数、助手消息数、逐工具调用明细与活动时间窗——官方投影不含这些字段（且旧值是「近期一段历史」的折叠，新值是**全日志**口径）
- **统计不再有加载/错误态**：无 RPC 即无需等待；宿主尚未投影该会话时显示「暂无统计数据」而非报错
- **「当前选中会话」自动标记已读已移除**：0.1.7-rc.2 不再暴露公开的当前会话标识（选区是工作区服务的私有状态）。手动标记（蓝点）与打开会话时标记读**不受影响**
- **设置页的「当前会话」标识与保护已移除**：当前会话不再被排除在批量/工作区选择之外，也不再受删除保护；删除现在仅对**运行中**的会话禁用（host 路由仍会以 `session-live` 拒绝活跃会话）
- **琥珀/绿色官方状态点**：原先靠改写官方 `SessionManager` 私有状态实现"就地已读"，该 API 已不存在；现在点击会**打开该会话**（即官方定义的已读动作，同时关闭面板/抽屉）。蓝点与运行中圆点的行为不变
- 语言字典：删除 6 个失效键（`statsLoading` / `statsFailed` / `statsUser` / `statsAssistant` / `statsTools` / `statsWindow`），新增 5 个（`statsSteps` / `statsLlmMs` / `statsToolMs` / `statsTtft` / `statsDecode`）

### 说明

- 统计功能现在依赖宿主的 `sessionStats` 投影单元被挂载（该单元随 DSH 发行，见 `@deepseek-ai/dsh-session-stats`）。若当前组合未挂载它，弹窗只会显示「暂无统计数据」，不会报错
- 仓库自带测试（`vitest`）3/3 通过；`tsc --noEmit` 与声明生成均 0 错误

## v0.2.2 (2026-08-20)

### 修复

- **macOS 打开日志目录**：在 macOS 使用系统 `open` 命令，不再错误调用 Linux 的 `xdg-open`；同时捕获文件管理器命令启动失败，避免未处理的 `ENOENT` 导致 DSH web 进程崩溃（[#10](https://github.com/dream12347/dsh-session-manager/issues/10)）

### 致谢

- 感谢 [cmj799](https://github.com/cmj799) 提交 Issue [#10](https://github.com/dream12347/dsh-session-manager/issues/10)，并提供清晰的错误日志、环境信息和修复建议

## v0.2.1 (2026-08-19)

### 修复

- **修复非默认 Agent 预设下保存压缩阈值报错**：通过 DSH 官方 `agentPresets` 服务解析预设的真实 composition 文件路径；系统预设不再尝试写入只读安装目录，用户预设仍正常持久化（[#9](https://github.com/dream12347/dsh-session-manager/issues/9)）

### 致谢

- 感谢 [Chen5173](https://github.com/Chen5173) 提交 Issue [#9](https://github.com/dream12347/dsh-session-manager/issues/9) 并提供详细的根因分析与复现信息

# 更新日志 (Changelog)

## v0.2.0 (2026-08-19)

### 修复

- **语言跟随 DSH 设置**：插件改用 DSH locale 服务判断当前语言并监听运行时切换，不再受浏览器语言或 `<html lang>` 影响；同时移除批量删除结果中的硬编码中文（[#5](https://github.com/dream12347/dsh-session-manager/issues/5)）

### 优化

- **官方按钮样式**：对话顶部按钮与 Session log 的尺寸、圆角和边框保持一致；设置页常规操作改用官方 `Button` 组件，并保留禁止换行与防收缩布局（[#6](https://github.com/dream12347/dsh-session-manager/issues/6)）
- **完整统计弹窗**：抽屉与设置页的统计信息统一改为屏幕中央弹窗，完整显示会话名、轮次、用户/助手消息、全部工具调用和活动窗口；支持关闭按钮、点击遮罩和 `Esc` 关闭，不再截断或依赖 tooltip（[#7](https://github.com/dream12347/dsh-session-manager/issues/7)）

## v0.1.9 (2026-08-18)

### 修复

- 串行化删除、恢复、彻底删除与压缩阈值保存操作，避免多个浏览器页面同时操作时使用旧状态互相覆盖
- 删除过程中移动文件或保存回收站记录失败时，自动恢复会话文件与归档状态，避免会话从列表消失但未进入回收站
- 保存回收站条目时保留已配置的上下文压缩阈值，避免其他会话操作意外清除该设置

## v0.1.8 (2026-08-18)

### 新增

- **对话管理抽屉「更多」菜单增加「删除」**：会话行三点菜单（统计 / 文件夹 / 新聊天中继续）新增红色「删除」项，运行中的会话禁用，与行内删除按钮一致（移入回收站）
- **会话管理面板支持批量删除**：每行前增加勾选框（运行中 / 当前会话禁用勾选），面板顶部出现「全选」与「批量删除」操作条，一次确认后逐个调用删除接口，汇总成功 / 失败数量，失败时列出失败会话标题；删除后刷新回收站与官方列表
- **工作区级全选**：会话管理面板中每个工作区（对话分类）标题旁新增勾选框，点击一次即选中该工作区下的全部可选会话（运行中 / 当前会话除外）；支持半选（indeterminate）状态，与「全选」按钮和每行勾选联动

### 优化

- 移除对话头部冗余的「回收站」按钮（「对话管理」按钮已能打开抽屉并定位回收站）

### 致谢

- 感谢 [DoggyHU](https://github.com/DoggyHU) 的贡献：批量删除、工作区级全选、更多菜单删除项与头部按钮清理（PR [#4](https://github.com/dream12347/dsh-session-manager/pull/4)）

## v0.1.7 (2026-08-18)

### 修复

- **子代理会话可删除**：放开子代理会话删除限制，非运行中的子代理会话（包括主会话已删除后遗留的「孤儿子代理」）均可删除；运行中的会话仍受保护不可删除
- **修复 `invalid-session-id` 报错**：官方会话 id 有三种形态（`session-<uuid>` / `session-<数字>` / 子代理纯 UUID），此前路由只接受第一种，导致子代理会话删除与打开文件夹失败，现已全部支持

## v0.1.6 (2026-08-16)

### 新增

- **未读 / 已读标记**（共享 `dsh.session-unread.v1` 格式）：会话行标题旁显示状态点——手动未读为蓝色、官方等待输入为琥珀、官方完成提醒为绿色、运行中为转圈；点击官方状态点就地标记已读（不跳转），点击蓝色点清除未读，打开会话自动已读；官方侧边栏对应会话行旁同步显示蓝色未读点
- **新聊天中继续**：每个会话一键 fork 子会话（官方 sessions.fork）并打开
- **抽屉「更多」菜单**：统计 / 文件夹 / 新聊天中继续收进悬浮菜单，行内更简洁
- **压缩阈值全局生效**：设置对所有 Agent 预设的会话统一生效（保存即时 + 持久化 + 重启自动应用）

### 修复

- 修复插件加载崩溃（ctx.effect 回调中的 TDZ 时序问题）

## v0.1.5 (2026-08-16)

### 新增

- **上下文压缩阈值**（通用设置）：设置对话上下文用到模型窗口（100 万 token）的多少比例时自动压缩（17%–90%）。每次压缩保留最近 16% 原文、其余折叠为摘要；保存后立即生效（含已打开的会话），并持久化到 Agent 预设，重启后依然有效；滑块两端与中间显示刻度（17% / 53% / 90%）

### 修复

- 会话管理面板行操作按钮（继续会话 / 暂停 / 统计 / 文件夹等）补齐边框样式
- 「删除」「彻底删除」按钮改为红色标识

### 变更

- 仓库与插件更名为 **dsh-session-manager**（原 dsh-delete-session），于 2026-08-16 改名，与插件当前定位（会话管理 + 工作区管理 + 压缩阈值）一致

## v0.1.4 (2026-08-16)

### 新增

- **工作区分组**：会话按工作区分组展示，组内按最后使用时间排序，可切换「最新在前 / 最旧在前」
- **拖拽调整工作区顺序**：拖动工作区标题即可排序——放到某个工作区上方/下方插入、拖到标题上交换位置、拖到列表末尾即移到最底部
- **工作区操作按钮**：悬停工作区标题显示「置于顶部 / 重命名 / 删除」；删除按官方定义：仅从工作区列表移除，文件夹与会话记录保留，其会话归入「未分组」，确认弹窗二次确认

### 变更

- 「未分类」更名为「未分组」，与 DSH 官方命名一致

## v0.1.3 (2026-08-15)

### 新增

- **统计**：每个会话可展开查看近期活动统计（轮次 / 用户消息 / 助手消息 / 工具调用 Top5 / 活动窗口）
- **继续会话**：一键打开会话并关闭面板，直接进入对话（运行中的会话禁用）
- **暂停**：停止正在运行会话的当前回合（仅运行中的会话显示该按钮）
- **文件夹**：在系统文件管理器中打开会话的日志目录
- **删除本对话**：对话顶部右侧新增红色删除按钮（Session log 左侧），一键删除当前对话
- **对话管理 / 回收站**：对话顶部新增两个入口，打开自绘右侧抽屉（会话列表 + 已归档 + 回收站），支持图钉固定常驻、点击外部自动收起
- **已归档会话支持恢复**：一键取消归档，回到会话列表
- 回收站条目显示删除时的会话名（不再显示会话 id 长串）
- 会话标题与路径悬停显示完整内容

### 变更

- 删除限制调整：仅禁止删除「正在思考」的会话；当前打开的会话（空闲）可以删除

## v0.1.2 (2026-08-15)

### 新增

- **回收站**：删除会话改为移入回收站（保留最近 10 条，超出后自动彻底清除最早一条），可在回收站中**恢复**或**彻底删除**
- 回收站条目显示删除时间，支持中英文

## v0.1.1 (2026-08-14)

- 修复：会话计数只显示活跃行数，不再显示包含归档/已删除会话的总数（如「2 个会话」代替「2 / 6 个会话」）
- 优化：删除成功/失败提示在 3.5 秒后自动消失

## v0.1.0 (2026-08-14)

- 初始发布：设置页新增独立的「会话管理」分栏
- 支持彻底删除会话（日志与记录一并清除），已归档会话在底部折叠区单独分组，均可删除
- 运行中 / 当前 / 子代理会话自动禁用删除，避免误删
- 已删除会话 id 记录在浏览器 localStorage，避免 live 会话删除后刷新「复活」
- 中英文界面自适应（跟随页面语言）
