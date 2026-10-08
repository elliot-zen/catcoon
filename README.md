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

## 使用

1. New issue：填写标题和描述，明确目标与完成标准。
2. 点击 Binding agents 中的 + Add，选择 Codex 或 Pi，填写该 Issue 中的 Agent description。工作目录由 `AGENT_WORKSPACE` 配置，必须已存在。
3. 可再绑定另一位 Agent，例如 Codex 实现、Pi 审查。
4. Start：Jev 读取目标、职责、历史结果，选择 Agent 执行。
5. Needs attention：查看具体请求，Approve、Reject 并填写反馈，或回答问题。
6. Agent turn 完成后由 Jev 判断接力、修订、人工决策或完成整个 Issue。
7. Stop：停止自动派发；正在执行的 turn 会先进入 Stopping，收到退出确认后才变为 Stopped。再次 Start 使用已有上下文继续。

活动流可查看每次决策和结果；Agent sessions 提供各 turn 的任务输入、增量回答、工具记录与最终结果。

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
- 有执行历史的 Binding 保留用于追溯，第一版不能删除，可以在停止后编辑职责。未决原生请求存在时不能修改目标或绑定。

## 技术结构

| 部分 | 实现 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite、CSS，Figma 本地图标及 Geist 字体 |
| API | Express 5，本机 HTTP 与 SSE 实时更新 |
| 存储 | Node 内置 `node:sqlite`，WAL、事务、单执行 / 单未决请求唯一索引 |
| 调度 | 显式状态机、运行代次校验、runtime 生命周期管理 |
| Codex | `codex app-server --stdio` JSON RPC，thread 恢复、审批响应、turn 中断 |
| Pi | `pi --mode rpc`，独立持久会话、自定义审批扩展，等待 `agent_settled` 才结束 |
| Jev | TypeSafe System One HTTP API，原子 Choice 问题及置信度校验 |

主要代码：

- `server/store.ts`：SQLite schema 和查询。
- `server/orchestrator.ts`：Issue 状态机、调度、审批、停止与恢复。
- `server/jev.ts`：目标判断、人工路由和绑定 Agent 选择。
- `server/runtime/`：Codex / Pi 适配器、JSONL 子进程协议和 Pi 审批扩展。
- `server/app.ts`：API 校验与 SSE。
- `src/main.tsx`、`src/style.css`：列表、详情、绑定、人工决策与会话界面。

Codex 使用 `workspace-write` sandbox 与 `on-request` 审批策略，不开启自动代批。Pi 第一版关闭自动发现的扩展，显式加载 Catcoon 扩展，在 `bash`、`write`、`edit` 执行前通过原生 RPC confirm 请求 Human 批准；读取操作直接执行。Pi 的审批门不是操作系统 sandbox。

## 配置与数据

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `TYPESAFE_API_KEY` | 必填；缺失时可创建和绑定，Start 路由会停止并显示原因 |
| `JEV_MODEL` | `jev-latest` |
| `JEV_URL` | `https://api.typesafe.ai/v1/systemone` |
| `JEV_MIN_CONFIDENCE` | `0.65`；判断不足时请求 Human 决策 |
| `MAX_TURNS` | `20`；达到上限时请求 Human；人工补充后重新计数 |
| `PORT` | `3000` |
| `DATA_DIR` | `.data` |
| `AGENT_WORKSPACE` | 当前项目目录；新绑定 Agent 的工作目录 |
| `CODEX_BIN` / `PI_BIN` | `codex` / `pi`；可以指定可执行文件绝对路径 |

数据库为 `.data/catcoon.sqlite`，Pi 会话为 `.data/sessions/`。Codex thread 由 Codex 自己保存，数据库记录其 ID。不要同时启动两个使用相同 `DATA_DIR` 的服务；服务锁会阻止重复启动。

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
