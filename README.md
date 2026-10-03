# Relay · Catcoon

本地单用户的 Issue 多 Agent 协同系统。以 `Project + Worktree + Agent + Triage routing description` 绑定工作范围，Jev 选择具体绑定，Codex / Pi 执行任务，Activity 和 Inbox 共用人工请求及审批记录。

正式规格：[索引](specs/spec.md)、[PRODUCT](specs/relay-collaboration/product.md)、[TECH](specs/relay-collaboration/tech.md)。视觉依据保留在 `docs/ui-design/`。

## 启动

需要 Node.js **24 或更高**、Git。无需部署数据库，SQLite 数据保存在 `data/relay.sqlite`。

```bash
npm install
npm run dev
```

打开 http://127.0.0.1:5173 。开发 API 在 http://127.0.0.1:4310 。生产模式：

```bash
npm run build
npm start
```

打开 http://127.0.0.1:4310 。可通过 `API_PORT` 和 `DATA_DIR` 改变服务端端口及数据位置。Vite 开发代理默认指向 4310。

## 使用

1. 在宿主执行环境安装并认证 `codex` / `pi`。Agent 页面探测真实版本；版本响应不等于模型认证通过。认证失败后，在终端修复工具认证，再点击 Agent 的 Refresh。
2. Projects → New project，选择真实 Git 仓库根目录。项目详情 → New worktree，登记已有 Worktree，填写实际分支、Spec 名称及相对目录（例如 `docs`）。应用不创建分支或清理已有文件。
3. PRODUCT.md / TECH.md 编辑器读取所选 Spec 目录中的文件，显式 Save 写入磁盘。未存在的文档显示空内容；可以让规格任务编写它们。外部修改触发冲突，需对比内容后再保存。发布版本会冻结材料，保存草稿不会自动审批。
4. Settings 保存 Jev API key，并 Test connection；也可以用 `TYPESAFE_API_KEY` 环境变量作为首次配置。密钥以 0600 文件独立保存，不从 API 返回。测试针对已保存的配置。
5. 创建 Issue，准备所有绑定及其 routing description，再从详情更多菜单 Start。开始后，Agent 自动提交成果、后续任务和问题/审批，Triage 根据绑定说明自动轮转；Issue 不提供手工创建任务、成果或请求的四个入口。普通评论只提供上下文；调整目标使用 Stop and correct，再 Resume。
6. Agent 通过实际 CLI JSONL 上报步骤及成果。输入问题和审批可从 Activity 或 Inbox 处理；选中答案后须 Submit answer。审批材料固定版本；Request changes 会产生修订任务。Agent 在修订交接中通过 supersedesId 替代旧请求或成果，并接管对应依赖。
7. 暂停阻止新分派，已有进程可能继续。Stop and correct 等待实际进程退出才释放锁。重启后的未确认执行显示 unknown 并保留 Worktree 锁；核查 PID、文件变更和外部副作用后，通过 Verify unknown run 保存证据，再明确重试或取消。
8. 所有必需任务及请求处理完毕后，系统创建最终验收；Human 批准该请求才设为 Done。重开需求会创建新目标，并保持暂停直到用户 Resume。

## 执行协议

Codex 使用 `codex exec --json --sandbox workspace-write -C <path> -`，Pi 使用 `pi --mode json --print --no-session -- <context>`。每次运行从数据库的有效目标、当前绑定、Spec 原文、固定成果、请求及人工决定重建上下文；不依赖原生会话迁移。

Agent 的最终消息应包含 fenced JSON。服务端提供该协议给 Agent：

```json
{
  "summary": "本轮实际结果",
  "artifacts": [
    { "kind": "report", "title": "可检查的变更及验证", "content": "实际证据" }
  ],
  "tasks": [
    {
      "text": "后续具体工作",
      "bindingId": "可选：当前 Issue 绑定 ID",
      "dependencyIds": []
    }
  ],
  "requests": [
    {
      "kind": "approval",
      "title": "审查规格",
      "body": "请求原因",
      "artifactIndexes": [0],
      "action": "按明确版本实现",
      "scope": "issue"
    }
  ]
}
```

`input` 请求可以设置 `routeToAgent: true`，由 Triage 路由问题任务，接手 Agent 用 `answer: {requestId,text}` 答复原请求；低置信或缺少合适绑定时同一请求转 Human。Agent 不能产生人工批准或最终验收决定。新成果/请求可分别提供 `supersedesId`，保留旧版本并接管对应审批依赖。

未提供结构化结果或可检查成果时，保存原报告并要求人工核查，不以退出码 0 自动证明需求完成。文件、代码和测试结果来自执行工具；测试报告标明来源，不宣称独立验证。二进制附件可下载，但文本适配器不会假称已理解其中内容，先请求 Human 提供必要内容的文本说明，再继续执行。

Jev 使用 [TypeSafe 官方 HTTP API](https://docs.typesafe.ai/api)，Choice 置信度阈值 0.65，最多 254 个绑定及 Human 选项；15 秒超时、网络/429/529/5xx 最多 3 次退避。单任务最多 8 次实际执行，单运行 30 分钟、每次 Start/Resume 最多 64 次实际运行；失败或结果不明不自动重放可能发生的写入。达到上限后用户明确 Retry 并提供核查依据，可开始新的尝试窗口。

服务仅监听 loopback，面向受信任的本地用户。Codex 使用其 workspace-write 沙箱；Pi 具备宿主用户权限，工作范围提示不构成 OS 隔离。应用保留原生工具权限策略，不提供任意操作自动批准；无法非交互继续的工具授权会体现为实际受阻结果。仅一个服务进程使用同一 DATA_DIR；不提供多实例调度。Spec CAS 可检测已发生的外部修改，但 Git/编辑器不参与应用锁，同一瞬间的外部写入仍需协调。外部写入和文件保存无法与 SQLite 组成跨系统原子事务，状态不明时须核查实际文件。

## 验证

```bash
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

后端测试使用临时 SQLite/Git 仓库、注入的 Jev 响应及真正启动的可控 JSONL 子进程。浏览器测试验证空数据启动、创建/绑定、两入口审批同步、Spec 保存/草稿隔离、搜索、偏好及窄屏操作。截图输出 `/tmp/relay-browser-desktop.png` 和 `/tmp/relay-browser-mobile.png`。

真实 Jev 认证及 Codex/Pi 的模型端到端任务需用户的有效密钥和工具认证；本仓库的自动测试不会消耗真实模型额度或修改用户项目。备份时停止应用后备份整个 DATA_DIR（包含凭据文件）；不要只复制运行中的 SQLite 主文件。
