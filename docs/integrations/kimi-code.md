# AGT-003：Kimi Code 接入调研与实现

调研日期：2026-10-09。真实 CLI 验证版本：Kimi Code **2.1.1**。

## 接入选择

Kimi 有旧 Python `moonshotai/kimi-cli` 和当前 TypeScript `moonshotai/kimi-code` 两套实现。旧版提供 `kimi --wire`；当前 2.x 的 `kimi --help` 没有该参数，提供 `kimi acp`。本次选择 2.x ACP，复用已安装 CLI 的本地认证、模型和工具，应用无须新增模型 SDK 或保存 Kimi 密钥。

| 方式 | 适用性 |
| --- | --- |
| `kimi -p ... --output-format stream-json` | 单次批处理；不能在同一进程内实现交互审批闭环 |
| 旧 `kimi --wire` | 旧 Python CLI 的协议；本机 2.1.1 不支持 |
| `kimi acp` | 当前官方双向 JSON-RPC 2.0 接口；支持流式输出、原生审批、会话与中断，本次采用 |

参考：[当前 CLI 命令](https://github.com/moonshotai/kimi-code/blob/main/docs/en/reference/kimi-command.md)、[当前 ACP 能力矩阵](https://github.com/moonshotai/kimi-code/blob/main/docs/en/reference/kimi-acp.md)、[旧 Wire 文档](https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/wire-mode.md)。文档通过 Context7 查询，并与官方源码、本机 CLI 握手结果交叉验证。

## 协议与生命周期

`server/runtime/kimi.ts` 启动 `${KIMI_BIN || "kimi"} acp`，进程工作目录使用绑定的绝对路径。标准输入输出逐行传输 JSON，日志留在 stderr。

1. `initialize`：`protocolVersion: 1`，提供 Catcoon 客户端信息，声明 `elicitation.form`。不声明文件和终端代理能力，工具在 Kimi 进程自己的环境中运行。
2. 新绑定调用 `session/new`，传入 `cwd` 和 `mcpServers: []`；数据库保存返回的 `sessionId`。恢复优先选能力声明中的 `session/resume`，否则使用 `session/load`。恢复失败停止，不自动新建会话。
3. 每轮调用 `session/set_mode` 覆盖会话旧审批/计划模式；指定模型时调用 `session/set_config_option` 的 `model` 配置项。
4. `session/prompt` 传入文本内容块。`session/update` 中的 `agent_message_chunk` 记为回答增量；`tool_call` 与 `tool_call_update` 根据 `toolCallId` 合并显示。恢复期间的历史重放不记录到新 turn。
5. 只有 `session/prompt` 响应中的 `stopReason: end_turn` 才表示本轮结束；流式文字或工具结束均不直接完成 turn。长任务和人工等待不套用控制 RPC 的 30 秒超时。拒绝、取消、空答案、协议错误、认证错误和提前断连显示失败原因。
6. Stop 发送 `session/cancel` 通知，并终止整个子进程组。Orchestrator 等到进程退出才释放执行占用；Stop 和 dispose 可重复调用。

会话由 Kimi 自身保存；Catcoon 的 SQLite 保存绑定 ID、Kimi 会话 ID、每轮回答、工具事件与人工决策。已有数据库的 runtime 字段是文本，无须变更 schema。

## 审批和补充信息

| Catcoon 级别 | ACP `modeId` | 行为 |
| --- | --- | --- |
| Strict approval（默认） | `default` | Kimi 原生人工审批；只读工具可直接执行 |
| On-request approval | `auto` | Kimi 的原生安全操作策略；其余请求交给 Human |
| Fully automatic | `yolo` | 原生全部工具自动执行，不经人工或自动评审 |

**ACP 的模式 ID 与 2.x CLI 开关名称不同**，映射以 `session/new` 的 `availableModes` 和[模式实现](https://github.com/moonshotai/kimi-code/blob/main/packages/acp-server/src/modes.ts)为依据。适配器在启动执行前检查对应模式存在，缺失时停止，避免降级为未知权限。

`session/request_permission` 的批准只返回 `allow_once` 对应的 `optionId`；拒绝返回 `reject_once` 或 `cancelled`，不选择 `allow_always`。Kimi 可并发发出多个工具审批；适配器排队逐个展示，满足应用同一 Issue 只能有一项未决 Human request 的约束。

结构化问题通过 `elicitation/create` 的 form 模式交给 Human，界面现有回答框提交 JSON，例如 `{"q0":"Server","q1":["API","UI"]}`。保存和恢复前用请求中的 JSON Schema 验证；无效回答保持原请求待处理。旧式 AskUserQuestion 的 permission 选项及多方案选择也作为 input 处理，不能因选项为 `allow_once` 就自动选择。URL 验证必须由用户确认。完全自动也不会伪造实际收到的问题答案或外部认证。

参考：[审批映射](https://github.com/moonshotai/kimi-code/blob/main/packages/acp-server/src/approval.ts)、[问答映射](https://github.com/moonshotai/kimi-code/blob/main/packages/acp-server/src/question.ts)、[ACP 交互桥](https://github.com/moonshotai/kimi-code/blob/main/packages/acp-server/src/interaction-bridge.ts)。审批是工具策略，不能当成操作系统 sandbox。

## 安装和使用

按[官方安装文档](https://moonshotai.github.io/kimi-code/en/guides/getting-started)安装 Kimi Code 2.x，例如 `npm install -g @moonshot-ai/kimi-code`。使用运行 Catcoon 的同一用户执行 `kimi login`，完成外部认证；应用不自动登录。

`.env` 可设置 `KIMI_BIN=/absolute/path/to/kimi`。在 Binding agents 的 + Add 中选择 **Kimi Code**，填写职责、目录与审批级别；保存不会启动 Agent。Start 后可由 Jev 选择 Kimi，并与 Codex/Pi 串行接力。空闲 Session 聊天恢复该绑定的原生会话。

验证：

```bash
npm test
npm run build
npm run test:browser
# 真实已登录的 CLI；会使用模型额度
npm run test:runtime -- kimi
```

`tests/fixtures/kimi.mjs` 模拟实际 ACP 子进程；测试覆盖新建与恢复、模型和目录、模式覆盖、流式 Unicode、批准/拒绝、并发审批、问答/多选/URL、错误、停止、审批期间 Stop/Start、独立聊天与重放去重。真实 smoke 验证本机认证及协议响应；真实 Jev 路由仍需有效的 `TYPESAFE_API_KEY`。

本次实际验证结果：全部 **72 项测试通过**，包含新增 21 项 Kimi/ACP 测试；TypeScript 检查和 Vite 构建通过；完整浏览器流程通过，包含 Kimi 绑定、聊天保存及运行中消息禁用；`npm run test:runtime -- kimi` 使用本机 2.1.1 的已有认证，真实返回 `CATCOON_RUNTIME_OK`。浏览器使用本机已有的 `/tmp/catcoon-browser-libs/usr/lib` 动态库目录运行。

## 已知协议边界

- 当前 ACP 没有 steer 方法，Kimi 明确拒绝并发的 `session/prompt`。运行中不能追加消息；界面提示等待结束或先 Stop，API 同样拒绝。空闲时仍可恢复会话聊天。参考[运行中 prompt 检查](https://github.com/moonshotai/kimi-code/blob/main/packages/acp-server/src/session.ts)。
- Kimi 的 ACP 将部分非认证引擎错误映射为 `end_turn`，没有独立失败原因字段。适配器能识别 RPC 错误、非正常 stopReason 和空答案，但无法从协议判断所有带部分文字的内部失败；这类情况需查看 Kimi 日志，Issue 是否完成仍由 Jev 判断。参考[结束原因映射](https://github.com/moonshotai/kimi-code/blob/main/packages/acp-server/src/events-map.ts)。
- 本次仅支持经验证的 Kimi Code 2.x ACP，不兼容旧 Python Wire 模式。默认模型、已禁用工具、宿主及组织限制由 Kimi 自身配置决定。
