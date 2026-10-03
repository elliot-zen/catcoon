# Relay · Catcoon

本地 Issue 多 Agent 协同系统。Jev 判断剩余目标并选择具体绑定；执行 Agent 自主规划，每轮原生终态回到 Triage，Human 处理规格审批与最终验收。SQLite 内置，无需部署数据库。

正式契约：[PRODUCT](specs/relay-collaboration/product.md)、[TECH](specs/relay-collaboration/tech.md)。UI 对照 `/home/elliot/workspace/tmp/ui-design`，新增交互限于已经确认的原位置调整。

需要 Node.js 24+、Git、已认证的 Codex（验证版本 0.160.0），以及 Pi **1.0.0**。

```bash
npm install
npm run dev
```

页面 http://127.0.0.1:5173，API 4310；浏览器使用同源请求。生产运行：

```bash
npm run build
npm start
```

生产页面 http://127.0.0.1:4310。`DATA_DIR` 默认 `data`，`API_PORT` 默认 4310；一个数据目录只运行一个服务。

1. Projects 登记 Git 项目和已有 Worktree。原 Spec 字段选择本项目的规格及版本，或输入新名称创建空版本；每个 Worktree 固定一个版本。
2. PRODUCT / TECH 编辑系统共享草稿，600ms 自动 CAS 保存。保存不写入 Git 文件，不改变固定版本或批准。冲突保留输入；核对当前草稿后可通过 `PUT /api/spec` 携带当前 draftRevision 明确解决。
3. Settings 保存 Jev key、Test connection。`TYPESAFE_API_KEY` 仅用于首次配置；密钥保存在独立 secret.json，不传给 Agent 或公开 API。
4. Issue 配置绑定和 Routing instructions，通过现有“…” Start。每条绑定在 Issue.sessions 中有独立会话，后续轮次复用。
5. Agent 用 `relay_spec_read`、`relay_report` 读取系统 Spec、提交版本与成果。审批卡明确显示版本、授权范围、升级目录及原版本；Approve 原子批准并升级列出的目录，其他 Worktree 保持原版本。
6. 自然语言回答和真实工具结果均可返回 Triage，不要求 fenced JSON 或手工创建下一任务。自动动作 Choice 低置信时要求确认具体范围或补充证据；final 直接检查覆盖与硬性条件后提出人工验收，避免重复澄清；Noul 按二值覆盖判断使用，不直接完成 Issue。
7. 有效证据、依赖与授权满足后送最终验收，Human 批准才 Done。Pause 阻止新派发；Stop and correct 保存纠正、中止并核查现场；Resume 使用最新事实；Done 新目标使用 Reopen。

Activity 每个 Run 一条，默认折叠；展开实时显示 Read、Exec、公开 Thinking 与 Answer。请求独立展示，Inbox 与 Activity 使用同一个决定。Codex 只显示原生公开推理摘要。

Codex 使用 `codex app-server`，通过本地 Unix WebSocket 连接，保存准确 thread / turn。终端连接同一会话：

```bash
npm run session
npm run session -- <bindingId>
```

等价于 `codex resume --remote <endpoint> <threadId>`。空 thread 必须先产生真实轮次才能恢复；终端主动开新 turn 前先 Pause Relay。终端额外 turn 记录来源，不当成平台交付。更换绑定目录或工具会归档旧会话；修改职责保持当前会话。

可用 `CODEX_APP_SERVER_ENDPOINT=unix:///absolute/path.sock` 或本机 loopback WebSocket 连接已有服务。Relay 仅停止自己启动的 app-server。连接失联保留 unknown 和实际目录锁，恢复准确原生 turn，绝不重发未知 prompt；人工核查通过 `run.reconcile` 提交真实 evidence。

Pi 使用 1.0.0 RPC、持久 session 文件和 Relay 扩展；`agent_settled` 才是整轮终态。未批准时开放读取及系统 Spec 工具，批准后开放实施工具，并核验带路径工具的目录范围。Pi 依赖宿主权限，不是 OS 沙箱；不宣称 TUI 同时附着活跃 RPC。RPC 退出并确认现场后，可通过 session 命令打开同一文件历史。

本版删除旧文件 Spec、手工任务 / 成果 API、最终 JSON 解析与旧数据迁移。旧 schema 拒绝启动。需要清库时先停止服务：

```bash
npm run db:reset
```

只重建应用 SQLite，清空业务、幂等、锁和过程记录；保留 secret.json、Codex 原生历史和 Pi 文件，不自动把旧会话重新绑定到新 Issue。

验证：

```bash
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:live
```

自动测试使用临时 Git / SQLite、协议 peers，覆盖版本 CAS、明确升级、批准边界、状态机、自然语言闭环、会话隔离、未知恢复、流式补发与清库。还直接验证已安装 Codex 的两个真实客户端共用 thread，以及 Pi 1.0.0 加载扩展和 RPC 状态。

浏览器测试对照真实设计源码，检查布局、目录登记、Spec 冲突、绑定、单 Run 流式 Activity、升级审批和偏好；`UI_DESIGN_DIR` 可指定设计目录。

`test:live` 使用本地 Jev key 和 Codex 认证，在隔离目录中通过浏览器 Start、测试驱动的人工审批及独立执行测试，验证 P21 / P22。真实 Jev 1.13.0 与 Codex 已完成这两个场景；证据保存在 `/tmp/relay-live-evidence.json`。Pi 的真实模型交付和完整交互 TUI 操作未列为已通过，只确认了 RPC 与会话协议。截图位于 `/tmp/relay-*.png`。

Jev 参数、独立题目与响应含义依据 [官方 API](https://docs.typesafe.ai/api)；模型输入限制依据 [官方模型文档](https://docs.typesafe.ai/models)，过量必要材料会明确阻塞，不静默截断。
