# Relay · Catcoon

本地 Issue 多 Agent 协同系统。用户绑定 Project、Worktree、Agent 和 Routing instructions；Start 后，Jev 路由具体绑定，Agent 自动交接成果、后续任务与请求，Human 处理审批和最终验收。

正式规格：[索引](specs/spec.md)、[PRODUCT](specs/relay-collaboration/product.md)、[TECH](specs/relay-collaboration/tech.md)。UI 按 `/home/elliot/workspace/tmp/ui-design` 的源码实现；新增内容仅限已确认的菜单控制、卡片审批按钮和原位置真实目录选择。

## 启动

需要 Node.js 24+、Git、已认证的 Codex（本次验证 0.160.0）与 Pi **1.0.0**。SQLite 内置，无需部署数据库。

```bash
npm install
npm run dev
```

开发页面 http://127.0.0.1:5173，API 4310，允许浏览器同源请求。生产启动：

```bash
npm run build
npm start
```

生产页面 http://127.0.0.1:4310。`DATA_DIR` 默认 `data`，`API_PORT` 默认 4310。一个数据目录只运行一个 Relay 服务。

## 使用

1. Projects 登记真实 Git 仓库；New worktree 登记已有目录和分支，不创建或清理 Git Worktree。新登记 Spec 使用该目录的 `docs/PRODUCT.md`、`docs/TECH.md`，已有登记保留其 specDir。
2. Spec 输入后自动 CAS 保存；Saved locally 只在实际确认后出现。冲突保留草稿并停止自动覆盖；先核对外部文件，通过 `/api/spec` 明确解决冲突。UI 不增加 Save/Publish 控件。
3. Settings 保存 Jev API key 并 Test connection；`TYPESAFE_API_KEY` 可作首次配置。密钥独立存储，不进入公开 API 或 Agent 上下文。
4. 创建 Issue、准备绑定，从详情现有“…”中 Start。Pause 只阻止新派发；Stop and correct 保存纠正并请求原生中止，需确认终态才释放锁。Resume 重新评估有效任务；Reopen 为 Done 提供新目标。
5. Activity 查看实际步骤、成果和请求，Inbox 处理同一请求。输入题填写选项值/标签或文本再提交；路由请求也接受唯一对应一条候选绑定的 Agent 名称，同名多绑定需填写完整选项或绑定 ID；审批卡内 Approve / Request changes 保存人工决定。Agent 自动产生下一轮，满足条件后自动送最终验收，Human 批准才 Done。

## Codex 同一会话的终端连接

执行使用 `codex app-server`，通过本地 Unix WebSocket 连接；每条绑定保存并复用 thread，每次执行保存准确 turn。不是 `codex exec`。

```bash
# 列出绑定的原生会话
npm run session
# 在本地 TUI 加入同一 app-server 和同一 thread
npm run session -- <bindingId>
```

等价于 `codex resume --remote unix://<DATA_DIR绝对路径>/codex.sock <threadId>`。首轮真正建立历史后可连接；空 thread 尚无 rollout 时不能恢复。`RELAY_URL` 可指定 API 地址。停止 Relay 会关闭其拥有的 app-server，历史仍在本地 Codex 会话目录。

若已有 app-server，设置 `CODEX_APP_SERVER_ENDPOINT=unix:///absolute/path.sock` 或本机 loopback `ws://127.0.0.1:<port>`；Relay 只连接，不停止这个外部服务。终端主动发起新工作前先 Pause Relay，避免跨客户端检查与派发之间的竞争；终端已有活跃 turn 时 Relay 等待，终端另起工作记录实际 Activity，不自动当成平台任务交接。原生工具审批可以在 Relay 或终端处理；终端已处理仅显示外部已处理，不伪造业务批准。

连接丢失/启动响应未知保留 unknown 与 Worktree 锁。重启按精确 thread/turn 恢复，已完成则收集原结果，仍活跃则继续监听，不重发 prompt。原生记录缺失需核查后通过 `run.reconcile` API 提交证据；没有新增核查面板。老 exec Run 保留历史，不猜测原生会话 ID。

## Pi 1.0.0

使用 `pi --mode rpc --session <DATA_DIR>/pi/<sessionId>.jsonl`，每轮复用原生文件。prompt response 只表示接受；重试、压缩与队列全部结束后的 `agent_settled` 才判定完成。停止先 clear_queue，再 abort 并等待 settled；异常退出保留 unknown，不自动重放。基于 1.0.0 随包文档，不使用旧 SDK 或 `--no-session`。

RPC 已退出且现场可确认时，`npm run session -- <Pi bindingId>` 可用 `pi --session <file>` 打开同一历史；本版不宣称 Pi TUI 同时附着活跃 RPC。Pi 使用宿主工具权限，绑定提示不等于 OS 沙箱。

## 自动交接协议

每轮上下文包含 Issue、绑定工作范围、Spec 原文、冻结成果、请求/决定和评论附件。最终消息使用 fenced JSON：

```json
{
  "summary": "本轮实际结果",
  "artifacts": [{"kind":"report","title":"变更及验证","content":"可检查证据"}],
  "tasks": [{"text":"下一项具体工作","dependencyIds":[]}],
  "requests": [{"kind":"approval","title":"审查规格","body":"原因","artifactIndexes":[0],"action":"按明确版本实施","scope":"issue"}]
}
```

`input` 可设置 `routeToAgent:true`，接手绑定用 `answer:{requestId,text}` 关联原问题。新成果/请求使用 `supersedesId` 替代旧版本并更新依赖。Agent 不能代签人工决定；无结构化/空交接保存原报告并请求核查，不自动声明完成。测试材料标明 Agent 来源。

Jev 使用 [官方 Choice API](https://docs.typesafe.ai/api)，阈值 0.65、15s 超时、网络/429/529/5xx 最多三次。单任务八次运行、单轮30分钟、Start/Resume 窗口64次；结果不明不重放写入。API 契约与恢复条件见 TECH。

## 验证

```bash
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

测试使用临时 SQLite/Git、可控 RPC peers、隔离 CODEX_HOME 与本地 HTTP 模拟 provider；实测两个真实 Codex app-server 客户端共享 thread，不调用真实模型。浏览器检查新设计布局、目录登记、可搜索绑定、审批同步、元数据持久化、Spec 自动保存/冲突、草稿和偏好。`UI_DESIGN_DIR` 可指定设计目录；截图保存在 `/tmp/relay-*.png`。

真实 Jev/Codex/Pi 模型端到端执行需要用户凭据，自动测试不代表这部分已验证。备份前停止应用，备份整个 DATA_DIR。
