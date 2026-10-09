# Catcoon

以 Issue 为中心的本地 Agent 协作系统。填写目标，绑定 Codex / Pi 及各自职责，由 Jev 判断下一步交给 Agent 还是 Human。

## 启动

需要 Node.js 24+，以及已安装、已登录的 `codex` 和 `pi`。第一版以 Linux 为运行环境。

```bash
npm install
cp .env.example .env
# 在 .env 中填写 TYPESAFE_API_KEY
npm run dev
```

打开 http://localhost:3000 。应用仅监听本机；默认不生成示例 Issue，也不会在创建或绑定时启动 Agent。

Jev 密钥从 https://console.typesafe.ai/keys 获取。Codex 和 Pi 沿用各自 CLI 的本地认证及默认模型，无须将它们的密钥粘贴进界面。绑定时可以指定模型。

生产模式：

```bash
npm run build
npm start
```

`npm run dev` 使用 Vite 开发服务；`npm start` 提供构建后的静态界面。二者都由同一个 Node 服务提供 API，无须另外启动前后端。

开发模式下，Vite 热更新 WebSocket 与 HTTP 共用 `PORT`（默认 `3000`），不额外监听默认热更新端口 `24678`。同时运行多个实例时，为每个实例设置不同的 `PORT` 和 `DATA_DIR`。

## 使用

1. New issue：填写标题和描述，明确目标与完成标准。
2. 点击 Binding agents 中的 + Add，选择 Codex 或 Pi，填写该 Issue 中的 Agent description 和 Working directory。目录默认预填 `AGENT_WORKSPACE`（未配置时为服务启动目录），每个 Agent 可独立修改；必须是 Agent 运行机器上已存在、可读取和进入的绝对路径。保存失败时保留表单，并在目录字段下提示原因。绑定保存不会启动 Agent。
3. 可再绑定另一位 Agent，例如 Codex 实现、Pi 审查。
4. Start：Jev 读取目标、职责、历史结果，选择 Agent 执行。
5. Needs attention：查看具体请求，Approve、Reject 并填写反馈，或回答问题。
6. Agent turn 完成后由 Jev 判断接力、修订、人工决策或完成整个 Issue。
7. Stop：停止自动派发；正在执行的 turn 会先进入 Stopping，收到退出确认后才变为 Stopped。再次 Start 使用已有上下文继续。

活动流可查看每次决策和结果；Agent sessions 提供各 turn 的任务输入、增量回答、工具记录与最终结果。

Issue 标题旁的 SquarePen 编辑图标可在任何状态下打开表单，统一编辑标题和 Description。保存不会中断当前 Agent、重发已发出的 Jev 请求或处理待审批请求；每次新的 Jev 决策从数据库读取最新标题和描述。需要立刻按新目标执行时，可手动 Stop 后再 Start。

发给 Jev 的 `state` 直接使用 JSON object，包含 `goal: {title, description}` 和 `history`。`history` 只保留最近一次 Agent 执行；若最新一次已回答的 Human 请求在该轮之后，则按 Agent、Human 顺序附上，最多两条。首次运行为空数组，没有 Agent 历史时可仅包含 Human 回答。每条含 `status/type/agent_id/agent_name/answer`；Agent 使用 Binding ID 和名称，Human 使用 `agent_id: null`、`agent_name: "Human"`。判断 Human 先后使用活动中记录的回答时间，未回答的请求不进入历史。候选 Agent 的职责放在 `questions.decision.criteria` 中；本地完整历史仍保留。

## 状态与执行规则

完整状态定义和状态图见 [PRODUCT.md](./PRODUCT.md)。

- 单个 Issue 串行执行，多个 Issue 可以各自推进。
- SQLite 是状态与历史的持久化来源；运行代次、当前 turn 和唯一索引共同防止重复派发。
- 一个 Agent 回答完成不直接结束 Issue；只有 Jev 判断目标已满足才进入 Done。
- runtime 的明确审批请求是硬性人工关口，不能被模型判断绕过。这类事件由 Orchestrator 确定性暂停；Jev 的目标判断及 Agent 选择使用真实 API。
- 原生审批批准或拒绝只恢复发出该请求的挂起 turn。拒绝内容还会保留在后续路由上下文中。
- Stop 不撤销已经产生的文件或外部效果；等待人工时 Stop 会保留挂起会话和审批，再次 Start 后才能处理。
- 重启后关闭自动推进，并核对、终止上次遗留的 runtime 进程。Linux 使用 PID 与 `/proc` 进程创建时间避免误认复用的 PID；确认结束后才能重新 Start。
- 重启会失去原生 RPC 连接，但保留人工请求内容。重新 Start 后先处理该请求，再带历史上下文规划新的 turn；新的工具操作仍需经过 runtime 自己的审批，不自动重放旧操作。
- 有执行历史的 Binding 保留用于追溯，第一版不能删除，可以在停止后编辑职责和审批级别。工作目录在首次执行前可修改；已有会话或执行历史后只读，需要新绑定来选择另一目录。未决原生请求存在时，Binding 仅允许在停止状态下修改未来轮次的审批级别，其他绑定字段仍需先处理该请求；Issue 标题和描述仍可随时编辑。

## 技术结构

| 部分  | 实现                                                                       |
| ----- | -------------------------------------------------------------------------- |
| 前端  | React 19、TypeScript、Vite、CSS，Lucide React 图标及 Geist 字体            |
| API   | Express 5，本机 HTTP 与 SSE 实时更新                                       |
| 存储  | Node 内置 `node:sqlite`，WAL、事务、单执行 / 单未决请求唯一索引            |
| 调度  | 显式状态机、运行代次校验、runtime 生命周期管理                             |
| Codex | `codex app-server --stdio` JSON RPC，thread 恢复、审批响应、turn 中断      |
| Pi    | `pi --mode rpc`，独立持久会话、自定义审批扩展，等待 `agent_settled` 才结束 |
| Jev   | TypeSafe System One HTTP API，原子 Choice 问题及置信度校验                 |

主要代码：

- `server/store.ts`：SQLite schema 和查询。
- `server/orchestrator.ts`：Issue 状态机、调度、审批、停止与恢复。
- `server/jev.ts`：目标判断、人工路由和绑定 Agent 选择。
- `server/runtime/`：Codex / Pi 适配器、JSONL 子进程协议和 Pi 审批扩展。
- `server/app.ts`：API 校验与 SSE。
- `src/main.tsx`、`src/style.css`：列表、详情、绑定、人工决策与会话界面。

Binding agent 可选择三档审批，每个绑定独立保存。绑定卡片右上角的三点菜单提供 Edit 和 Session，分别打开编辑窗口和该 Agent 的会话界面。停止 Issue 后可以修改审批级别；有未决原生请求时也可保存审批级别，其他绑定字段暂不可修改。新策略从下一轮运行生效；已挂起的 turn 保留原策略和请求，再次 Start 后仍需处理该请求。会话历史保留，运行中禁止编辑。

Session 支持文字聊天，Enter 发送，Shift+Enter 换行。空闲时沿用绑定的原生会话启动一轮，结束后停留在 `stopped`，点击 Start 才继续自动调度；已完成 Issue 的聊天结束后仍为 `done`。运行中只允许向当前 Agent 追加消息（Codex `turn/steer` / Pi `steer`），不创建并行 turn。消息和回复保存在 SQLite，可重新进入会话查看。发送失败保留草稿；等待人工时请先处理 Issue 顶部的审批或回答卡片，聊天不能代替审批。Issue 底部不再显示聊天输入框。

会话中的用户消息靠右并按内容宽度显示。Agent 等待输出时显示轻微闪烁的 Thinking…，开始输出或调用工具后显示每秒更新的 Working for … s，结束后显示固定的 Worked for … s。工具过程在正文上方，点击耗时行可折叠，工具开始与结束事件合并显示，已完成回复支持复制。Issue 详情右侧的 Properties 卡片显示状态、文件夹、创建人和时间信息；不同状态使用不同颜色，列表和会话页同步使用相同状态配色。

| 级别                           | Codex                                                                                     | Pi                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Strict approval / 严格审批     | `read-only` + `on-request`，需要额外权限的操作（包括文件修改）请求人工审批                | 每次 shell、写入、编辑和其他非只读工具调用请求人工审批                                                                |
| On-request approval / 按需审批 | `workspace-write` + `on-request`，工作区内常规操作直接执行，额外权限由 Codex 发起人工审批 | 工作区内 write/edit 和简单只读命令 `pwd/ls/cat/head/tail/wc` 直接执行，其他 shell、工作区外写入及未知工具请求人工审批 |
| Fully automatic / 完全自动     | `danger-full-access` + `never`，关闭 Codex 沙箱，已启用工具直接执行，不经人工或自动评审   | 无工具审批，沿用 Pi 进程的系统权限，不经自动评审                                                                      |

Codex 的前两档使用 `approvalsReviewer: user`；完全自动不会启用 `auto_review`。`never` 只表示禁止弹出审批，必须搭配 `danger-full-access` 才对应本项目的完全自动。宿主环境、组织策略、工具禁用状态及服务端权限仍有效。旧版本已保存的 Codex Automatic 在首次升级时迁移为按需审批，并记录活动；需要完全自动时请显式重新选择，以免升级静默扩大权限。Pi 已有自动档行为不变。更早版本没有审批字段的绑定仍迁移为 Codex 按需、Pi 严格。

适配器支持 `mcpServer/elicitation/request`：简单确认表单按当前级别审批；完全自动直接同意并写入会话日志。需要填写信息的表单始终等待用户输入 JSON 并按工具提供的 schema 校验；URL 验证需要用户完成外部验证后确认。未支持的验证模式返回取消，不伪造验证结果，也不会因未知请求直接终止整个运行。

Pi 显式加载 Catcoon 审批扩展，关闭自动发现的扩展。只读工具 `read/grep/find/ls` 在各档直接执行；按需模式的 shell 仅放行上述单条命令，重定向、命令组合、替换和转义均需审批。工作区路径检查包含符号链接，但审批门不是操作系统 sandbox。三档均保留 Agent 的人工补充信息请求。

## 配置与数据

| 环境变量               | 默认值 / 用途                                        |
| ---------------------- | ---------------------------------------------------- |
| `TYPESAFE_API_KEY`     | 必填；缺失时可创建和绑定，Start 路由会停止并显示原因 |
| `JEV_MODEL`            | `jev-latest`                                         |
| `JEV_URL`              | `https://api.typesafe.ai/v1/systemone`               |
| `JEV_MIN_CONFIDENCE`   | `0.65`；判断不足时请求 Human 决策                    |
| `MAX_TURNS`            | `20`；达到上限时请求 Human；人工补充后重新计数       |
| `PORT`                 | `3000`                                               |
| `DATA_DIR`             | `.data`                                              |
| `AGENT_WORKSPACE`      | 当前项目目录；新绑定 Agent 的工作目录                |
| `CODEX_BIN` / `PI_BIN` | `codex` / `pi`；可以指定可执行文件绝对路径           |

数据库为 `.data/catcoon.sqlite`，Pi 会话为 `.data/sessions/`。Codex thread 由 Codex 自己保存，数据库记录其 ID。不要同时启动两个使用相同 `DATA_DIR` 的服务；服务锁会阻止重复启动。

Jev 调用默认在服务终端打印 `[Jev request]`、`[Jev response]` 和失败时的 `[Jev error]` 日志。同一调用通过 `requestId` 关联，包含请求地址与完整请求体、原始响应体、HTTP 状态和耗时；网络、超时及解析错误也会记录。Authorization 不打印，API Key 在日志中脱敏。

## 验证

```bash
npm test
npm run build

# 完整浏览器 happy path，使用隔离 SQLite 和测试 runtime，无模型费用
npx playwright install chromium
npm run test:browser

# 1440 × 960 设计稿布局核对，截图输出 /tmp/catcoon-ui-*.png
npm run test:design

# 已登录的真实 Codex 和 Pi 各执行一次只读响应，会使用模型额度
npm run test:runtime
```

已有 Chromium 可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome` 运行浏览器测试。浏览器截图输出至 `/tmp/catcoon-{approval,detail,list,mobile}.png`。

测试覆盖创建与绑定、两种 runtime 的真实子进程协议、审批挂起与响应、Agent 接力、停止恢复、迟到决策、SQLite 重启恢复及 Jev HTTP 请求契约。浏览器流程使用测试适配器；真实 runtime smoke 只验证认证、协议与响应，真实 Jev 的语义路由需要配置有效密钥后验证。

参考：[Figma 设计](https://www.figma.com/design/RfuMz07kH8mSoAhEMmRpFG/Catcoon?node-id=0-1)、[Jev 文档](https://docs.typesafe.ai/introduction)、[Codex App Server](https://developers.openai.com/codex/app-server)。
