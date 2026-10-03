# TECH — Relay 多 Agent 协同系统

> 版本：0.6 · 2026-10-03 · 目标契约，尚未重构实现。
> 产品语义与验收编号见 [PRODUCT](product.md)。单进程、本地单用户，SQLite，无需外部数据库。

## 1. 代码组织

保留 Node.js 24、React、Vite、Tailwind 及现有 UI。职责按以下边界实现：

| 位置 | 职责 |
| --- | --- |
| server/store.ts、server/types.ts | 业务状态、迁移、事务、幂等、Issue 内 session 与持久化约束。 |
| server/domain.ts | Issue 状态机、绑定、控制、Request 决定和最终验收。 |
| server/specs.ts | 系统 Spec 草稿、不可变版本、批准引用、Worktree 固定版本与升级。 |
| server/files.ts | Git 仓库 / Worktree 的 realpath、common-dir、分支及现场验证；不再作为 Spec 原文存储。 |
| server/context.ts | 分别构建 Jev 状态与 Agent 输入，固定版本、过滤失效决定与秘密。 |
| server/triage.ts、server/jev.ts | 持久触发、硬条件检查、类型化判断、响应校验和派发决定。 |
| server/runtime.ts、server/agents/ | 启停、原生协议、精确会话 / turn 关联、终态与恢复。 |
| server/streams.ts | 原生事件归一化、持久消息块、SSE、补发与去重。 |
| server/index.ts | HTTP、同源检查、变更串行入口与恢复顺序。 |
| scripts/agent-bridge.mjs | 所选 Agent 可调用的本地 Spec / 成果 / 请求读写入口，读取 stdin JSON，经服务验证。 |
| server/agents/pi-extension.ts | Pi 1.0.0 的系统规格工具与每轮工具范围校验；不参与业务批准。 |
| src/api.ts、src/activity.ts、src/App.tsx | API / SSE 客户端、单 Run 展示分组、原设计布局和草稿。 |

浏览器与 Agent 均不能直接决定业务状态、审批或目录升级。Jev 不执行工具。接口和流式模块依赖领域服务，不反向从 UI 推导事实。

## 2. 已有设计与修改边界

| 现有位置 | 复用 / 修改 |
| --- | --- |
| Store.change / publicState | 保留事务、幂等和秘密过滤；新增 schema 3，并将 session 权威记录移入 Issue。 |
| Domain.action / dependencies / finalReady | 保留来源及依赖关系；改为 §4 的状态机和结构化等待原因，最终验收必须包含目标覆盖判断。 |
| Runtime.context / dispatch / complete / ingest | 拆分上下文和 Triage；取消“只有 tasks 才继续 / 无 JSON 就转人工”的前提，原生结果与业务报告分别处理。 |
| files.readSpec / saveSpec、/api/spec | 替换为系统 Spec 服务；旧文件读取仅用于迁移。 |
| agents/codex.ts、agents/pi.ts、scripts/session.mjs | 保留 app-server、Pi 1.0.0 RPC、准确原生身份与终端连接。 |
| Runtime.step / nativeNotice、activity.ts | 保留准确 Run 分组；替换过滤 thinking 和最终才展示消息的逻辑，接入 §8 流式块。 |
| tests/core.test.ts、native.test.ts、activity.test.ts | 原生身份、审批和隔离用例继续适用；旧文件 Spec、过滤 thinking、固定 JSON 交接用例按新契约替换。 |

视觉只读依据是 /home/elliot/workspace/tmp/ui-design/src/App.tsx 与 src/index.css。原始 docs/PRODUCT.md 是需求输入，不承担新模型的实现契约。

## 3. 数据与持久化

### 3.1 存储和约束

继续使用 DATA_DIR/relay.sqlite、WAL、BEGIN IMMEDIATE、busy_timeout。业务集合保存在 state.json 单行文档中，schemaVersion=3；这意味着下面的 Issue 字段实际存入持久化 Issue 记录，不另建与其并行的 session 主数据表。

保留 operations(key PRIMARY KEY, fingerprint, response, created_at) 记录幂等确认；同键同请求返回原结果，同键异请求 409 IDEMPOTENCY_CONFLICT。保留 locks(path PRIMARY KEY, run_id UNIQUE) 按 canonical realpath 占用目录；unknown 不释放。模型请求和原生调用在事务外执行，事务内再次复核快照。

新增流式表，避免每个 token 重写整个 state：

- stream_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, item_key TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL, received_at TEXT NOT NULL, dedup_key TEXT UNIQUE)；索引 (issue_id,seq)、(run_id,seq)。
- stream_items(run_id TEXT NOT NULL,item_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,content TEXT NOT NULL,first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(run_id,item_key))；索引 (run_id,first_seq)。

关联 ID 写入时在同一 SQLite 事务验证，不能因 SQLite 的 JSON 文档没有 SQL 外键而省略归属检查。流式表仅保存通过身份检查的 Run / 原生执行记录；去重键由适配器可确认的原生 ID / 终态哈希构成，不能按 delta 文本去重。

### 3.2 业务实体

ID 为 UUID，时间为 UTC ISO8601；revision 为非负整数，版本号为正整数。所有创建 / 修改通过领域事务写入。

| 实体 | 核心字段与约束 |
| --- | --- |
| Project | id,name,path,commonDir,health,healthReason,checkedAt；Git commonDir 为仓库身份。 |
| Spec | id,projectId,name,draft:{product,tech,revision,baseVersionId},latestVersionId,createdAt,updatedAt；属于一个项目，名称不作为身份。 |
| SpecVersion | id,specId,number,product,tech,contentHash,createdAt,sourceIssueId?,sourceRunId?,previousVersionId?；(specId,number) 唯一，发布后不可改写。 |
| Worktree | id,projectId,name,branch,path,specId,specVersionId,revision；path canonical 唯一，Spec 与版本必须属于本项目 / 指定 Spec，两引用必填。 |
| Issue | id,number,title,description,corrections:[{id,text,at,source,targetRevision,stopResolved}],targetRevision,status,started,control,revision,createdAt,updatedAt,priority,labels,sessions:Session[],triage:{dirty,evaluationRevision,phase,triggerIds},runBudgetStart；status 为四个既有值。 |
| Binding | id,issueId,projectId,worktreeId,agentId,description,revision,removed,activeSessionId?；生效四项组合唯一，activeSessionId 必须引用所属 Issue.sessions 的本绑定记录。 |
| Session | id,bindingId,agentId,projectId,worktreeId,path,generation,status,threadId?,nativeSessionId?,sessionFile?,endpoint?,toolVersion,busyTurnId?,createdAt,parentSessionId?；见 §7。 |
| Task / 工作事项 | id,issueId,kind(goal/clarification/revision/followup),text,sourceId,requestId?,status,bindingId?,dependencyIds,attempts,waitReason?,retryAt?；状态 pending/running/waiting/done/cancelled/unknown。 |
| Run | id,issueId,origin(platform/terminal),taskId?,bindingId,sessionId,nativeTurnId?,mode?,snapshot,contextRef?,status,stopRequested,startedAt,finishedAt?,resultArtifactId?,ingestedAt?；状态 starting/running/stopping/completed/failed/stopped/unknown。platform 必须有 taskId/mode/contextRef；terminal 只观察原生事实，不应用平台交接。 |
| Evaluation | id,issueId,triggerIds,evaluationRevision,snapshotHash,input,answer?,model?,usage?,status,createdAt；状态 pending/evaluating/applied/discarded/failed，用于可定位的判断与恢复。 |
| Artifact | id,issueId,runId?,bindingId?,kind,title,content,contentHash,specVersionId?,supersedesId?,provenance,createdAt；固定文本 / 证据。 |
| Request | id,issueId,taskId?,runId?,kind,inputClass?,title,body,options?,objectRefs,scope,action,status,answer?,decision?,decidedBy?,decidedAt?,revision,source,recipient,supersedesId?,supersededById?,native?,resolutionEvidence?。 |
| Notification | id,requestId,issueId,category,read,archived,createdAt；同 Request 一个通知。 |
| Comment / Attachment | 所属 issueId、原文 / 上传内容、类型及时间；完成上传后才成为上下文。 |

Issue.control 为 enabled/paused/stopping。waitReason 为结构 {code,requestIds,runIds,conditionKey?,message,recoverable}，不再通过错误文案前缀决定是否允许恢复。

Issue.triage.phase 为 idle/evaluating/running/waiting；Session.status 为 uninitialized/idle/busy/unknown/archived。Run.snapshot 冻结 targetRevision、绑定 revision 与四项范围、Worktree revision、specId/specVersionId/contentHash 和有效批准引用；contextRef 指向 state 内 contextSnapshots 集合的不可变记录 {id,runId,payload,contentHash,createdAt}。公开 state 不返回该集合或 Evaluation.input。

Request.kind 为 input/approval/final；inputClass 为 business/configuration/recovery/native。status 使用 PRODUCT §8.2 的八个值。scope 明确 issue / taskIds / bindingIds / worktreeIds；依赖只能引用本 Issue 的 task / request。objectRefs 可引用固定 artifact、SpecVersion 和目标版本，不用可变草稿作批准对象。

scope 的 JSON 类型为 "issue" 或 {taskIds:string[],bindingIds:string[],worktreeIds:string[]}，对象形式至少一个非空数组；旧 task ID 数组归一化为 taskIds。Request.recipient 为 Human/Agent；来源 source 为 Human/Triage/Agent/System。澄清任务以 requestId/sourceId 指向原问题，只豁免其要回答的这个输入阻塞；回答验证通过后该任务 done、原 Request Answered、原任务依赖重评估。配置请求只有登记的 conditionKey 谓词可置 Resolved，任意业务问题不能使用该机制。

批准 Spec 的 action 为 approve_spec:{specVersionId,worktreeIds,allowedModes}；允许组合升级的 action 为 approve_spec_and_upgrade:{specVersionId,targets:[{worktreeId,fromVersionId,worktreeRevision}],allowedModes}。批准记录还保存批准时的 Issue.targetRevision / 任务范围。单独升级 action 不自动产生实现授权。

Agent 可用性和绑定职责分别保存；sessions 不按 Agent 服务全局共享。所有按 Issue 查询从 issueId 找记录；session 从 Issue.sessions 按 id / bindingId 找，Run.sessionId 能定位历史会话。

### 3.3 迁移与兼容

schema 2 → 3 在停止 worker 派发并核查旧活跃运行后进行，先备份数据库；迁移不启动 Agent：

1. 将顶层 sessions 按 binding.issueId 移入 Issue.sessions，保留 ID、准确 thread / 文件及 Run 引用；补 generation=1 和状态。无归属记录不能猜测，保留迁移诊断并阻止启动完成。
2. 为每个旧 Worktree 的 specName/specDir 读取旧 PRODUCT / TECH，建立 Spec、初始 SpecVersion、固定引用和共享草稿。相同名字不自动合并；归属不明、不可读或路径逃逸时回滚。旧文件明确不存在时可导入为空，并记录各文件的 missing 来源标记；不能声称读到了已有内容。
3. 同一个明确旧文档来源可按项目 + canonical 两文件路径去重；不同来源即使内容相同也保留独立 Spec，复用需人工明确重新分配。
4. 旧 Agent spec artifact 仅在 PRODUCT / TECH、范围与版本可准确匹配时关联 SpecVersion；无法证明适用性的旧批准保留历史，新实现须有效批准。
5. 补 control、targetRevision、结构化 waitReason 与持久 triage 标记。旧失败 / stopped 保留现场及恢复请求，不能直接重跑；unknown 保留目录占用。
6. 迁移成功才写 schemaVersion=3；失败原事务回滚。对外 state.sessions 可作为由 Issue.sessions 派生的兼容读字段，不构成第二事实源。

旧 /api/spec 的 worktreeId 查询可继续解析到固定 Spec 并返回新响应；旧写入若缺 specId、draftRevision 或试图写文件，返回 409 SPEC_CONTRACT_CHANGED，不误写共享草稿。新前端采用 §9。旧 task.create / artifact.publish / request.create 可保留兼容校验，但不作为 UI 推进入口。

## 4. Issue 状态机

所有变更通过 Domain 事务，然后标记需要重新评估；输出 token 和 stream_items 更新不改变业务 evaluationRevision。

主状态计算：

```text
若已有针对当前目标的有效最终批准：Done
否则若 started=false：Todo
否则若存在有效、未被替代的阻塞 Human Pending 请求：Human input
否则：In progress
```

最终批准只能由 request.decide(final,approve) 创建；Done 变更仅允许 reopen。最终请求的 Pending 本身计作 Human 阻塞；执行失败或暂停不自动等于 Done。Request changes 是待修订依赖，不是一个尚需 Human 回答的 Pending，因而可进入 In progress 开始修订。

Start 在首次事务中 started=true、control=enabled，建立唯一 sourceId=Issue.id 的 goal 事项。重复调用不重复事项。goal 事项保存整个目标；每个成功 Run 只完成其本轮处理，不把 goal 直接设 done。

Pause → control=paused。Stop → control=stopping、保存纠正与新的 targetRevision、相关 Run.stopRequested=true；事务后发送 interrupt。全部相关终态确认后转 paused；旧待派安排失效，保留未完成目标，Triage 从纠正和现场重建推进，不创建 text=p.text 的独立“stop”任务。

Resume 在无未确认 stop / unknown 恢复依赖且核查条件满足时 control=enabled，将已确认停止的 correction.stopResolved=true，开启新的运行预算窗口，dirty=true；否则 409 RESULT_UNKNOWN / DEPENDENCY_BLOCKED。上下文明确旧停止指令已恢复，保留业务纠正及原目标，不把历史停止文本作为当前任务。Reopen 只在 Done 接受非空目标，递增 targetRevision，清除当前完成标记，保留历史，新 goal pending、control=paused。

目标、固定 Spec、绑定或有效决定改变，递增相关 Issue.evaluationRevision，使旧模型决定失效。普通草稿、心跳、token 不递增。修改 title / description 通过 revision CAS；有效目标修订影响旧派发及验收。工作进行中保存新目标不改当前 Run.snapshot，须暂停 / 停止后调整其执行依据。

finalReady 校验当前目标覆盖的应用 Evaluation、全部必需非 goal 事项、有效批准、无业务阻塞、无 active/unknown Run 或 busy session、非空可检查成果与验证说明。Jev 选择 final 时在同事务将 goal 标 done 并创建 final Request；批准前再次核查目标与材料引用。final Request changes 重新打开 goal、建立 sourceId=Request.id 的修订事项。

最终确认的阻塞检查仅排除正在批准的那个 final Request，不能把它自己的 Pending 当作无法验收的阻塞。final 冻结 targetRevision、成果哈希和 Spec pin；创建该请求本身增加的业务 revision 不废弃自身完成判断，实际目标 / 材料 / 授权变化则必须重新评估。

依赖 Approved / Answered / 配置 Resolved 可通过；Cancelled / Superseded 不算通过。修订事项仅豁免自己正在修订的 Changes requested 对象，不能豁免其他依赖。配置谓词满足后系统记录 Resolved 和实际依据；不会使用自动“回答”伪造 Human 决定。

## 5. Spec 服务与批准升级

草稿按 specId 共享，用 draftRevision CAS；PUT 成功才递增草稿 revision。PRODUCT 与 TECH 可分别编辑，但发布时必须传预期 draftRevision，原子冻结完整一组文档，contentHash=SHA256(UTF-8(JSON.stringify({product,tech})))，键序固定且正文不 trim，分配递增版本号并更新 latestVersionId。latestVersionId 不决定任何 Worktree 的采用版本。

创建 Spec 同事务建立空初始版本、草稿和最新引用；创建 Worktree 检查真实 Git、归属、版本，再保存必填 specId / specVersionId。SpecVersion 原文在数据库中读取；文件同名、mtime 或 Git 分支不能改变关联。

发起实现审批时 PRODUCT 和 TECH 均须非空且可读，否则 400 MATERIAL_UNREADABLE；空初始版本不能被批准用来实现。

Agent 按 §6.4 提交草稿或版本。发布新的实现依据时自动生成 Spec approval，材料引用 SpecVersion 两份原文；涉及升级时列出明确 fromVersion、目标目录与授权范围。Agent 可以提出升级目标，只有 Human request.decide 才能实施。

SpecProposal 必须属于自身 Worktree 关联的 Spec，baseVersionId 与本轮输入一致，draftRevision 仍为当前值；完整 pair 的草稿写入、版本冻结和请求创建同事务完成。升级建议只能列本 Issue 生效绑定中的同项目 / 同 Spec Worktree。发布审批后 Agent 应结束本轮等待决定，不在未批准状态继续实现。

批准 + 升级事务顺序：

1. 校验 Request Pending / revision、Issue 目标、SpecVersion 身份、对象哈希和授权动作。
2. 校验每个目标属于 Spec 项目、采用 fromVersion、Worktree.revision 未变化。
3. 检查目标目录无 active/unknown Run、busy native session 或未确认停止。
4. 记录 Human 批准，更新全部明确目标的 specVersionId / revision，标记所有受影响 Issue 重新评估，归档相同 Request 的通知，一起提交。
5. 任一步失败整体回滚；旧页面或原生占用返回稳定 409，保留 Pending。不列出的目录不变。

单独批准仅创建有效决定；单独人工升级接口只改变 pin，并不补造批准。新版本若没有适用的批准，Triage 发起该版本的审批再实现。重新关联另一个 Spec 同样须人工明确、同项目、有固定版本且目录不忙。

实现 / 涉及代码修订 / 测试模式在派发和启动两次验证批准覆盖 (issue,target/task scope,worktree,specVersion,mode)。spec、clarify、read-only inspect 不要求实现批准；revise 的允许动作必须区分修改规格与修改代码，不能以“修订”绕过实施授权。

Spec 的新草稿不废弃现有版本批准。显式替代审批对象时旧 Request Superseded，依赖改指向新请求；已经运行的任务依旧有准确旧快照，若授权被明确撤销则请求停止，核查后恢复。

## 6. Jev 参数、响应与自动闭环

### 6.1 触发和硬条件

每秒 worker 消费持久 Issue.triage.dirty；合并多个触发保留 triggerIds。目标或依赖变化先应用领域规则，再生成 Evaluation 的不可变快照；同 Issue 只有一个 evaluating / active Run。

等待时将准确 conditionKey 写入相关事项 waitReason；每秒先复查条件，Agent 可用性、目录恢复、其他 Issue 释放同路径锁或关联决定变化时置 dirty。没有条件变化只保留等待，不重复调用 Jev。

Done、未 Start、paused / stopping、已知 busy / unknown 原生执行先等待，不调用模型。审批只阻塞相关范围，可先处理其他合法事项。配置恢复自动解决对应 configuration 请求；业务问题保持其决定边界。无事实变化不因轮询重复判断。

硬条件包括：合法绑定 / 项目目录、固定版本、批准范围、已知目录占用、依赖、运行预算和上下文容量。Jev 输出不能放宽这些条件。

### 6.2 state 与 questions

调用 POST https://api.typesafe.ai/v1/systemone，Authorization: Bearer 使用服务密钥，Content-Type: application/json，model=jev-latest。官方类型和响应字段依据 [API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Noul](https://docs.typesafe.ai/primitives/noul)。

state 由 context 服务构建并保存在 Evaluation，字段固定：

| 字段 | 传入内容 |
| --- | --- |
| schemaVersion,evaluationId,evaluationRevision,trigger | 本次判断身份和触发事实，不作为模型授权。 |
| issue | id,number,title,description,targetRevision,control；有效纠正和需求原文，验收要求来自需求 / Spec，不增加 UI 字段。 |
| bindings | 本 Issue 生效绑定 id,description,agentId,projectId,worktreeId；各自实际可用性、目录、分支、specVersionId、批准及阻塞。 |
| specs | 每个候选固定 SpecVersion 的 PRODUCT / TECH 原文、ID、哈希；相关待审版本及共享草稿，标明用途，不能混成当前依据。 |
| workItems | 未完成事项、来源、状态、依赖；已完成事项保留关联证据。 |
| requests,decisions | 当前有效问题及人工决定，对象版本、scope、action；失效决定只以历史关联说明，不作为授权。 |
| artifacts | 当前相关契约、代码 / 测试 / 报告的完整材料及 provenance；替代链明确。 |
| recentRuns | 最近结果、失败 / 停止原因、实际公开 answer、可检查工具结果与其 Run / Session / turn ID；不传 thinking。 |
| comments,attachments | 当前 Issue 评论、已读取文本与附件元数据；未读取材料明确标识，不能评估为已阅读。 |
| constraints | 串行、批准、版本、权限、运行预算以及 final 的硬条件计算结果。 |

不传其他 Issue 原生对话、Jev key、Agent 认证、整个进程环境或无关项目文件。候选 Session 只传 busy 等可用性，不将完整聊天作为 Jev 记忆。

Jev state 采用独立 schemaVersion=1；规格引用先按 ID 去重，再完整附原文。与 Agent 输入相同，必需内容超过256KB时记录 MATERIAL_UNREADABLE 容量阻塞，不静默裁掉正文或决定。

一次请求并行询问独立问题；每题依据同一 state，不引用另一题尚未产生的回答：

```json
{
  "model": "jev-latest",
  "state": {
    "schemaVersion": 1,
    "evaluationId": "<evaluationId>",
    "evaluationRevision": 7,
    "trigger": {"ids": ["<eventId>"], "type": "run.completed"},
    "issue": {"id": "<issueId>", "number": "REL-1", "title": "实现用户管理", "description": "添加、编辑、删除和列表", "targetRevision": 1, "control": "enabled", "corrections": []},
    "bindings": [{"id": "<bindingId>", "agentId": "codex", "projectId": "<projectId>", "worktreeId": "<worktreeId>", "description": "规格与后端实现", "projectName": "backend", "path": "/workspace/backend", "branch": "feature/users", "specVersionId": "<versionId>", "availability": {"agent": "available", "worktree": "healthy", "sessionBusy": false}, "approval": {"approved": false, "requestIds": []}, "blockedBy": []}],
    "specs": [{"specId": "<specId>", "versionId": "<versionId>", "product": "<固定产品原文>", "tech": "<固定技术原文>", "contentHash": "<sha256>"}],
    "workItems": [{"id": "<taskId>", "kind": "goal", "text": "实现用户管理", "status": "pending", "sourceId": "<issueId>", "dependencyIds": []}],
    "requests": [], "decisions": [], "artifacts": [], "recentRuns": [], "comments": [], "attachments": [],
    "constraints": {"approvalRequired": true, "canFinalize": false, "blockedReasons": []}
  },
  "questions": {
    "next_action": {
      "type": "choice",
      "instructions": "根据当前目标、成果和硬条件，选择下一动作。不得把成功执行或空任务队列等同目标完成。",
      "criteria": {
        "dispatch": "存在可在合法绑定范围推进的工作",
        "wait": "已有明确依赖或环境条件阻塞，等待条件变化",
        "human": "需业务澄清、裁决或无法可靠判断",
        "final": "目标有材料覆盖且满足最终验收前提，提交 Human 验收"
      }
    },
    "dispatch_mode": {
      "type": "choice",
      "instructions": "若需要执行，当前主要处理类型是什么？只判断类型，具体步骤由执行 Agent 规划。",
      "criteria": {
        "spec": "规划或修改系统规格",
        "implement": "依据获批固定版本实现代码",
        "verify": "检查成果和实际验证",
        "clarify": "回答关联问题",
        "revise": "根据明确修改意见修订",
        "inspect": "读取并核查现场或补充结果",
        "none": "当前不应派发"
      }
    },
    "route": {
      "type": "choice",
      "instructions": "按具体绑定的职责与范围选择处理者；资料不足、说明冲突或无合适范围时选 human。",
      "criteria": {
        "human": "需人工决定或没有匹配绑定",
        "<bindingId>": {
          "description": "<原始说明>",
          "project": "<实际项目>",
          "worktree": "<真实目录与分支>",
          "specVersionId": "<固定版本>",
          "availability": "<实际条件>"
        }
      }
    },
    "goal_complete": {
      "type": "noul",
      "instructions": "当前有效目标的全部必需工作是否已有可检查成果和验证说明覆盖？Agent 自称完成、被截断材料、失效批准均不能单独作为证据。"
    }
  }
}
```

实际 state 是对象，route.criteria 包含全部本 Issue 生效候选，不是占位符字符串。最多 254 绑定 + human。问题类型与固定选项由代码生成，需求 / description 作为数据，不接受其改写系统问题。

workItems 中若存在刚结束 Run 处理的非 goal 事项，state.currentWorkItem 固定该事项与结果，并增加 work_item_complete:{type:"noul",instructions:"state.currentWorkItem 的准确范围是否已有相应成果覆盖？澄清必须有原请求的有效答案。"}。该结果 >=0.90 且关联证据 / 请求校验通过后，领域事务可将该事项置 done；否则保持 pending 或其真实依赖 waiting。goal 只能按 §4 最终验收准备规则完成。由此自然语言报告也能完成修订 / 后续事项，无需强制 JSON。没有此事项时不发送或消费该问题。

### 6.3 响应处理

Choice 读取 type、choice、confidence、probabilities；Noul 读取 type、noul。校验问题齐全、type 匹配、choice 属于请求候选、所有概率有限且在 [0,1]、候选键完整、和误差 ≤1e-6、confidence / noul 在 [0,1]。存实际 model、usage、完整 typed answer 和 snapshotHash，不伪造模型解释。

只消费当前动作所需结果：非 dispatch 忽略 mode / route 的决策意义，final 同时检查 goal_complete；按请求中存在的题目校验可选 work_item_complete，在领域事务中先更新对应事项，再检查 final 条件。采用既有 Choice 阈值 0.65，目标覆盖门槛 noul>=0.90；低于阈值不能自动提交最终验收。Noul 数值不是 Choice confidence。

处理顺序：

1. 响应后比对 evaluationRevision、目标、绑定、Spec pin、control。变化则 Evaluation=discarded、重新 dirty，不派发。
2. next_action 置信不足 → 一个有来源的 Human 路由 / 目标核查请求。
3. dispatch → mode 必须非 none，相关 mode / route 置信均 >=0.65，route 为具体合法 binding；否则 Human。Agent 之前建议的 bindingId 是参考，不能跳过本轮重新评估。
4. final → goal_complete>=0.90 且 §4 的硬条件全部满足，才创建明确最终验收；否则不能结束目标，安排可解释的核查或 Human 请求。
5. wait → 必须能定位实际未满足条件；没有可定位条件时转核查，不能无限空等。
6. human → 使用现有原问题 / 修改请求的材料，或固定模板引用最新报告生成澄清卡；Jev 不生成问题正文，代码不能凭选择结果编造缺失业务字段。
7. 判定相互矛盾或超出授权时拒绝动作、保存 typed answer 和具体校验原因，转核查；不选择概率第二高候选冒充原判断。

启动事务再次验证版本、批准、依赖、session busy 和目录占用，再创建 Run 与冻结 context。模型结果经硬条件复核后才由领域事务完成 goal；模型不能直接设置批准状态。

Jev 超时15秒；网络 / 429 / 529 / 5xx 最多3次，指数退避500ms、1000ms，可遵守 Retry-After。401 / 422 和无效协议不重试。失败保存健康等待与一次配置请求，配置变化才重新评估；不循环生成请求。

### 6.4 Agent 输入与业务报告

Agent 输入是以下结构化对象加执行规则。每轮存 contextRef 指向不可变快照；必要原文总量超过256KB时阻塞并说明缺失，不静默截断。

| 字段 | 内容 |
| --- | --- |
| execution | runId,sessionId,mode,taskId,requestId?,trigger,开始时 evaluationRevision。 |
| issue | 当前目标原文、targetRevision、纠正和验收依据。 |
| assignment | 自身四项绑定、真实目录与分支，其他有效绑定的职责和范围。 |
| spec | 固定 specId/specVersionId、PRODUCT / TECH 完整原文、hash；spec 模式另附 draft / draftRevision / baseVersion 和待审版本。 |
| permissions | 本 Issue 对准确对象、模式、目录的有效批准，待决 / 失效请求及禁止动作。 |
| workItems,requests | 当前及相关未完成事项、依赖、待答问题与原文，明确哪个 request 可由本轮回答。 |
| artifacts,recentResults | 所需完整成果、接口契约、测试 / diff 与来源；其他 Run 的必要结果，不能靠完整聊天替代。 |
| comments,attachments | Issue 评论、文本附件和真实读取结果；二进制在适配器未支持直接输入时要求文本说明。 |
| bridge | 本地辅助命令的绝对路径、runId、可用操作与结构，用于读系统 Spec、提交成果及请求。 |

执行规则：依据自身范围自主规划；代码实现使用已批准固定版本；保留既有现场；不得扩大目录、代签批准或执行未授权合并 / 部署；报告实际验证与缺失，必要时提问或提交候选后续事项。原生 session 历史与本轮输入并存，但本轮版本及有效决定优先。

bridge 读取 stdin JSON，POST /api/runs/:runId/report；报告结构：
```text
{
  specProposal?: {specId,baseVersionId,draftRevision,product,tech,upgradeTargets:[{worktreeId,fromVersionId,worktreeRevision}]},
  artifacts?: [{kind,title,content,supersedesId?}],
  requests?: [{kind:"input"|"approval",title,body,scope,artifactIndexes,action,routeToAgent?}],
  answer?: {requestId,text},
  suggestions?: [{text,bindingId?,dependencyIds?}]
}
```
报告 Idempotency-Key 必填。服务验证当前 Run / session、同 Issue、对象归属、准确依赖、有效状态和允许操作；Agent 不可创建 final、批准、升级 pin、修改别的 Issue 或回答无关问题。SpecProposal 发布原子版本与明确审批对象，不能直接改已发布内容。bridge 同时提供 GET 读取当前系统草稿 / 固定版本；不要求 Spec 原文落进 Git。

原生 relay_report 的幂等键由宿主按 sessionId + turnId + toolCallId 稳定生成；同一调用重送不重复发布。CLI bridge 每次人工 / Agent 明确操作生成并保留 UUID，网络重试复用该值；相同键不同参数按指纹拒绝。

为使批准前的规格写入不依赖开放仓库写权限，Codex 在 thread/start 注册 relay_spec_read、relay_report 两个 dynamicTools，通过 item/tool/call 交由宿主领域服务处理；Pi 1.0.0 extension 注册同名工具调用相同服务。relay_spec_read 参数 {specId,document,versionId?}，返回 §9 的文档结构；relay_report 参数即上述报告，宿主以实际 thread/turn 解析 Run，不能信任模型自报的 runId。对 terminal-origin 的调用只允许范围内读取，不接受平台业务报告。CLI bridge 是相同服务的辅助入口，不是唯一模型写入路径。

每次报告全体校验通过后事务应用，失败无部分成果 / 请求。业务报告错误与原生执行事实分开保存，不能把“无效业务字段”改写为整个原生执行没有发生。自然语言 answer 通过原生流保存，不要求最终 fenced JSON；旧 fenced JSON 可解析为兼容报告，但无效或缺失时仍触发 Triage，按已有事实继续核查。

原生终态事务保存完整公开回答为 report Artifact，关联代码 / 工具证据与已提交业务报告；把本轮事项恢复到可评估或其真实依赖状态，dirty=true。停止意图存在时不自动应用被中止输出中的派发建议。ingestedAt 和终态 dedup 防重复应用。

没有可检查成果时不会最终验收，Triage 可选择 inspect / verify 补充；缺报告不直接制造永久“Execution failed”阻塞。连续相同目标 / 版本 / mode / 结果且无新增材料计无进展，3轮转 Human；成功补齐材料、升级版本或有效答复才重置。保留每事项8次执行、每 Run 30分钟、每 Start/Resume 窗口64次实际 Run 的保护。

## 7. Issue 内 session 与原生执行

每条生效 binding 在 Issue.sessions 至多一个未 archived 的当前 Session，Binding.activeSessionId 是引用。首次派发先事务建立 status=uninitialized 的逻辑记录，准确原生 ID 返回后更新；不能用模糊名称识别会话。generation 为每绑定递增历史序号，parentSessionId 为以后新开 session 保留关系；本版没有新开操作或接口。

同一 Issue 内两个 Worktree 上的 Codex 各自独立；跨 Issue 即便相同工具 / 目录也不共享 session。编辑 description 继续复用当前会话；改变工具或目录先确认旧执行结束，再归档旧 Session 并按新范围建立。Run 永远引用其执行当时 Session。

Codex adapter 使用 owned 的 codex app-server --listen unix://<DATA_DIR>/codex.sock，或 CODEX_APP_SERVER_ENDPOINT 指定本地服务；initialize / initialized 后按 thread/start、thread/resume、turn/start 执行。新 thread 为持久模式、cwd=绑定真实目录、on-request，继承本地认证并去除 Jev key；experimentalApi=true 支持系统 dynamicTools。每轮 turn/start 显式设置 sandboxPolicy：未取得实现批准的 spec / clarify / inspect 为 readOnly，获批实现 / 测试为 workspaceWrite 且 writableRoots 仅绑定目录，不能沿用上一轮的宽权限。启动 / RPC 超时15秒；未确认 turn/start 不能重发。

Session 保存 endpoint/threadId，Run 保存 nativeTurnId；通知先于 turn/start 响应时按准确 thread 关联本次 starting Run，确认后固定 turn。只有匹配 turn/completed 的 completed/failed/interrupted 转成 completed/failed/stopped；单个 agentMessage / command 完成不能结束 Run。

发送前 thread/read 查询 active turn；终端活跃时记录 busy 并占用实际目录。跨客户端无原子 compare-and-start；终端主动执行前应暂停 Relay。npm run session -- <bindingId> 从所属 Issue.sessions 读取，执行 codex resume --remote <endpoint> <threadId>，不 fork。空 thread 未形成可恢复记录时返回明确错误。

Pi 使用已安装 @earendil-works/pi-coding-agent 1.0.0 随包 docs/rpc.md、docs/json.md、docs/message-types.md。pi --mode rpc --session <DATA_DIR>/pi/<sessionId>.jsonl，LF JSONL 分帧；get_state 保存准确原生 session ID / 文件。prompt response 只表示接收；message_end 是权威消息，agent_end 仍可能重试 / 压缩，只有 agent_settled 才结束整轮。clear_queue 后 abort，等待 settled 确认 stopped，不使用旧 print / no-session。

Pi 加载 Relay extension，依据实际 Run 在 prompt 前更新工具范围。批准前只启用已验证的 read 与系统规格 / 报告工具，关闭 bash/write/edit 和其他未明确允许的工具；tool_call 对嵌套调用也校验。获批后恢复本轮允许的工具；不能仅把“等待批准”写在 prompt 中。原生请求涉及超出本轮业务范围的写入时先补业务批准，原生命令批准不绕过 Spec 检查。Pi 扩展依据同包 docs/extensions.md 的 setActiveTools、registerTool 与 tool_call 阻止能力。

原生审批以 (sessionId,rpcId,turnId,itemId) 关联 Request；按协议回复真实允许值。answer 保存和原生发送确认分开，delivery=sent/confirmed/unknown；serverRequest/resolved / 终端处理不伪造业务批准。原生终态清理失效的本 turn 请求；其历史保留且不永久阻塞后续验收。秘密输入在原生终端处理。

关闭 owned app-server 断开客户端但保留原生历史；external 服务不由应用停止。连接失联标 Run / Session unknown 并保留锁。重启先冻结活跃记录，再按准确 thread/turn 恢复：明确终态只摄入一次，仍活跃挂接等待，缺失保持 unknown；Pi 不凭打开会话文件认定旧 Run 成功。现场核查接口必须有非空 evidence，禁止无依据释放占用。

## 8. 流式协议与展示

依据 [Codex App Server 公开事件](https://learn.chatgpt.com/docs/app-server) 与 Pi 1.0.0 随包事件协议，原生通知映射为统一 stream item；不扫描隐藏会话文件抽取工具未公开的推理。

| 统一内容 | Codex | Pi 1.0.0 |
| --- | --- | --- |
| Answer 增量 | item/agentMessage/delta，按 itemId 拼接 | message_update.assistantMessageEvent 的 text_start/delta/end，按 message + contentIndex |
| Thinking 增量 | item/reasoning/summaryTextDelta、summaryPartAdded；只呈现公开可读摘要 | thinking_start/delta/end；只呈现事件提供的内容 |
| 工具生命周期 | item/started、item/completed 的 commandExecution / fileChange / MCP 等 | tool_execution_start/update/end，以 toolCallId 关联 |
| 命令输出 | item/commandExecution/outputDelta | tool 的 partialResult 与最终 result，按该工具语义替换或扩展 |
| 权威内容 | item/completed | text_end / thinking_end 和最终 message_end |
| 整轮终态 | 对应 turn/completed | agent_settled，结合最终 stopReason / error |

Codex 原始 reasoning/textDelta 不作为公开摘要的替代；模型未提供摘要时不生成 Thinking。工具内容依据真实 commandActions / toolName 显示：已确认 read → Read，命令 → Exec，其他使用真实名字，不按模糊文本猜测读取。内部 item key 含 session、turn、原生 item / 消息标识；Pi 没有 message ID 时使用本连接的持久 message 序号 + contentIndex，重连靠最终快照核对。

增量先写 stream_events 并更新 stream_items，同事务确认后推送 SSE。最终权威内容替换局部拼接结果，不再次追加完整文本。token 不更新 Issue.updatedAt；开始、业务成果、请求和终态更新业务时间。公开 thinking 持久化供刷新查看，但不进入 Jev 或其他 Agent 共享上下文；不保存未公开推理、签名块或凭据。

Codex 重连时 thread/read(includeTurns) 获取完整 items 校正；没有可重放的原生 token ID 时不能盲目重复拼接，先 snapshot replace 再接新流。Pi 最终 message 校正已缓存块，无法确定的增量标 interrupted，不能伪造完整过程。

GET /api/stream?issueId=<id> 使用 SSE，event:stream、event:item.snapshot 的 id 为 SQLite seq，支持 Last-Event-ID 或 after 游标；event:state.changed 不设置 id，仅提示重新读取 /api/state，不能推进流游标。stream payload 为 {seq,issueId,runId,sessionId,turnId?,itemKey,kind,operation:"append"|"replace"|"status",data}。初次读取整个 Issue 的 items 快照及全局 lastSeq（同一数据库读事务），再订阅 after=lastSeq，消除多 Run 快照窗口丢失。

每 Run 顶层一条默认折叠 Activity；请求按 requestId 独立行默认展开。stream_items 在展开区按首次 seq 排序，更新原块；调用内参数、stdout、状态与结果可折叠。收到新流不改变用户展开状态。原生终端额外 turn 记录准确 origin=terminal 的独立运行观察，不当作平台 goal 完成。

单次原生事件公开载荷上限64KB，超限明示截断；权威材料要求完整可读，不能把截断数据作为批准或完成依据。高频 delta 可100ms批量事务但维持顺序，批次提交后推送。SSE 慢消费者断开后按 seq 补发，不拖住原生 stdout；不无限缓存内存。连接错误保留最后确认快照与现有状态位置，不新增状态面板。

## 9. HTTP 与界面契约

同源 / loopback 写入允许，Vite changeOrigin=false；继续拒绝跨 Origin 写入。body 最大12MB，单附件5MB；敏感配置独立 secret.json、0600，不进入 state / prompt / stream。所有变更 Idempotency-Key 必填，revision CAS，失败统一 {error:{code,message,details?}}。

| 接口 | 输入 / 输出 |
| --- | --- |
| GET /api/state | 公开业务集合，新增 specs / specVersions 摘要和 Issue.sessions / triage 状态；不返回 key、Run.context、完整大流式载荷及附件二进制。 |
| GET /api/specs?projectId= | [{id,projectId,name,latestVersionId,versions:[{id,number,contentHash}]}]，供原 Spec 字段选择。 |
| POST /api/specs | {projectId,name} → {spec,initialVersion}；创建初始空版本，不批准。 |
| GET /api/spec?specId=&document=product\|tech&versionId= | 指定不可变版本 → {specId,versionId,document,content,contentHash}；省略 versionId 读取共享草稿 → {specId,document,content,draftRevision,baseVersionId}。 |
| PUT /api/spec | {specId,document,content,draftRevision} → 保存后的草稿结构；409 SPEC_CONFLICT 包含当前草稿。 |
| POST /api/specs/:id/versions | {draftRevision} → {version,revision}，发布完整 pair；本地 Human 或经 Run 范围校验的 Agent 调用。 |
| POST /api/worktrees/:id/spec | {specId,versionId,revision,reason} → {worktree,affectedIssueIds,revision}；Human 明确分配 / 升级，未批准仍不允许实现。 |
| GET /api/runs/:id/items | {items:[{itemKey,kind,status,content,metadata,firstSeq,lastSeq}],lastSeq}，供单 Run 展开读取。 |
| GET /api/issues/:id/items | {runs:[{runId,items}],lastSeq}，同一读事务获取本 Issue 全部块与全局流游标，供首次订阅 / 重连。 |
| GET /api/stream | §8 的 SSE，必须验证 issueId 与非负整数游标。 |
| POST /api/runs/:id/report | §6.4 结构 → {appliedIds,revision}，当前 Run 范围内业务操作；Agent 不能调用 Human decide。 |
| POST /api/actions | 继续 {type,payload} → {result,revision}；下表约束。 |
| GET /api/directories、/api/attachments/:id、/api/health | 保留真实目录、原附件和健康读取。 |

文档类型为 product/tech，正文 UTF-8、单文档最多1MB；不存在实体404，不属于项目 / Spec 的引用422；输入为空或非法400。已登记目录重新关联 / 升级只通过人工动作；不允许 Agent 借 report 绕过。

actions 保留 issue.create/update/control、binding.save/remove、comment.create、attachment.create、notification.update、request.decide、run.reconcile、settings.save/test、agents.refresh。worktree.create 为 {projectId,name,path,branch,specId,specVersionId}；创建新 Spec 的表单改用同一动作的互斥分支 {projectId,name,path,branch,newSpec:{name}}，同事务创建空初始版本与 Worktree。不接受 specName/specDir 写文件。issue.control 的命令 start/pause/resume/stop/reopen；内部 final 与兼容外部 final 均须完整复核，不提供手工 UI。

request.decide={requestId,revision,decision:"answer"|"approve"|"changes"|"cancel",answer?}。组合升级仅由被冻结的 action 解释，不从回答中的“同意”猜测。run.reconcile={runId,outcome:"completed"|"failed"|"stopped",evidence}，只用于未知现场核查； completed 仍要回 Triage，不能直接 Done。

错误：400 INVALID_INPUT / MATERIAL_UNREADABLE；404 NOT_FOUND；409 STALE_VERSION / SPEC_CONFLICT / SPEC_CONTRACT_CHANGED / REQUEST_RESOLVED / DEPENDENCY_BLOCKED / WORKTREE_BUSY / RESULT_UNKNOWN / IDEMPOTENCY_CONFLICT / DUPLICATE_BINDING；422 INVALID_REPOSITORY / BRANCH_MISMATCH / SPEC_PROJECT_MISMATCH；503 JEV_UNAVAILABLE / AGENT_UNAVAILABLE。409 保留输入与原请求，服务异常不返回秘密。

原有 Spec 字段支持按项目搜索已有 Spec / 固定版本或输入新名创建，事务失败不留下孤立 Worktree；新 Spec + Worktree 提交用领域组合动作同事务保存，创建实体接口供其他调用使用。固定版本与草稿编辑状态在已有 Bound spec / 状态区域说明，不增独立版本面板。草稿按 specId/document 保存，600ms 防抖 CAS；系统确认才能展示保存成功。

UI 其余行为沿用 PRODUCT §10。Agent / Project Health 定期真实检查；Search / 列表 / 统计从实体去重计算；主题与语言 localStorage；评论、请求与绑定草稿按所属 ID 隔离。新增原型外入口必须另行确认。

## 10. 恢复与一致性

启动顺序：完成版本迁移 → 冻结未确认运行 / session → 恢复准确原生状态与待决原生请求 → 校正 stream item → 重新计算业务状态 / dirty → 开启 worker。未知运行或停止意图未确认时不释放目录占用或开替代 session。

持久 dirty 在派发启动事务中与 Evaluation.applied 一起处理；期间出现新触发保留待处理 revision，不能被旧确认清掉。HTTP 与原生终态同一 SQLite 串行事务；原生启动在事务外，starting + Session 身份先落盘，返回丢失按未知恢复。

final、批准升级、关联请求答复、报告应用与通知状态均在单事务写入。外部动作与数据库无法构成同一事务，结果确认丢失按精确身份核查，不把幂等 key 当作原生命令去重能力。

停止应用不自动回滚原生副作用，owned / external 服务所有权遵循 §7。现有未知历史在 migration / reconciliation 完成前保留，不借重构重跑用户工作。

## 11. 验证

验收编号与可观察结果统一定义于 [PRODUCT §11](product.md#11-验收场景)。下表给出验证入口、必要输入和内部断言；全部用于重构后的目标契约。规格阶段只检查文档，不运行应用或迁移用户数据。

### 11.1 自动化验证

后端使用临时 SQLite / Git、可控原生 peers 和注入 Jev typed 响应；时间与故障可控，不依赖真实模型随机选择。每次失败同时检查事务内数据和原生调用计数，不能只断言错误文案。

| 层级 / 编号 | 关键输入与操作 | 必须核验 |
| --- | --- | --- |
| domain/API / P01、P02 | 多 Spec、两个已有 Worktree、不同 pin；无 Spec / 跨项目 / 分支错误 / canonical 重复目录及 newSpec 组合动作。 | 正确归属、固定引用必填；非法输入无残留实体，组合创建同事务，Git 分支与文件不被改写。 |
| specs/browser / P03 | 两目录关联同 specId；草稿 CAS 竞争、重载、修改同名本地文件。 | 数据库正文和 draftRevision 为权威；共享可见、冲突输入保留、历史版本 hash 与 pin 不变。 |
| native/domain / P04 | spec 模式读取 / relay_report，随后尝试未批准的写入与命令；再使用有效批准启动。 | Codex 每 turn 的 sandboxPolicy、Pi active tools 与嵌套 tool_call 拦截实际生效；空 pair 不可批准，实现批准与 writableRoots 准确。 |
| specs/domain / P05 | 冻结 V2 + 升级 W1；并发改变 fromVersion / revision，busy 与 unknown 各测一次。 | Request、批准及所有目标 pin 原子提交或回滚；W2 不变，受影响 Issue dirty，旧 Run.snapshot 不变。 |
| worker / P06、P22 | 自然语言终态、无 tasks / JSON；当前已获批且可直接实现，另有不相关绑定。 | 真正终态令 dirty；重新询问动作 / mode / route，contextRef 准确；不强制 spec 阶段或遍历绑定，不因无 JSON 卡死 / 空队列完成。 |
| worker/domain / P07 | 缺绑定请求后补齐；Agent / 目录恢复，业务审批仍 Pending。 | configuration 按 conditionKey 置 Resolved，实际条件变化触发一次评估；业务决定和其他依赖保持。 |
| domain/worker / P08 | 活跃 Run 时 Pause，再保存决定、完成旧 Run、Resume。 | control 与主状态独立，旧执行可结束、暂停期间 launch 次数不增，Resume 使用新 evaluationRevision。 |
| domain/worker / P09 | goal_complete 达标但有缺口 / unknown / 无批准；合法 final、changes、重新 final、旧确认。 | 硬条件失败无 final；自身 Pending 可被排除且仅排除自身，最终批准唯一 Done 入口；修订、新 Request 与冻结证据不复用旧决定。 |
| store/native / P10、P27 | 同 Agent 多绑定 / 多 Issue、连续 Run、重启；改职责、移除、换 Agent / 目录。 | Issue.sessions 独立、准确 ID 复用；旧忙状态阻止更换，确认后归档建新范围；Run.sessionId 历史不改写。 |
| Jev/context / P11 | 完整 state / questions，缺字段、NaN、错 type / choice / 概率和、低置信与动作矛盾；模型响应前改变目标 / pin / 绑定。 | 四个基本题与可选事项题参数准确；坏响应不派发，过期 Evaluation discarded，保存实际 typed answer；Agent 路由建议不能跳过 Jev。 |
| context / P12 | 固定 V1、latest V2、待审草稿、旧原生历史、失效决定、附件不可读；必要输入超过256KB。 | Jev / Agent 两种快照各自字段正确，必要原文与范围齐备；无 latest 替换 pin、其他完整会话 / thinking / 秘密，容量不足明确阻塞。 |
| native/streams/browser / P13 | Read / Exec 与 text / thinking delta 交错、多内容块及调用 ID，持续展开 / 收起。 | 一 Run 一顶层行，首次 seq 顺序与真实调用名称；参数、输出、状态和文本实时更新，不以每句 / delta 创建行，不重置展开。 |
| native/SSE / P14 | Codex item 完成但 turn 未完成；Pi agent_end 后继续，最终 settled；快照订阅窗口、断线、重复最终消息、慢客户端、64KB超限。 | 仅整轮终态结束；SQLite seq 补发无遗漏，完整权威内容 replace，重复不重复摄入；无公开 thinking 不补造，超限明确，生产者不被阻塞。 |
| domain/browser/native / P15 | Activity / Inbox 并发决定，未提交输入、已读 / 归档 / cancel、终端 resolved；唯一 / 同名 Agent 简称。 | 同 requestId 单次决定，空答复与歧义不改请求，草稿保留；原生 delivery 可核查，不产生业务批准，取消不授予权限。 |
| domain/worker / P16 | 原工作有两个依赖，另一绑定回答原 requestId；无匹配者或答错 ID。 | 只解除关联输入，澄清任务仅豁免自己的请求；无匹配沿原请求升级 Human，不重复通知，不回答无关问题。 |
| recovery/native / P17 | turn/start 回应丢失、失联 / 未确认停止后重启；原生分别报告 active / terminal / missing。 | 精确身份恢复、不重发 prompt；unknown 锁保留，已知终态只摄入一次，reconcile 无 evidence 拒绝。 |
| native/domain / P18 | 同 Issue 两候选、两个 Issue 同 canonical path，终端活跃 turn 与原生额外 turn。 | 最多一个平台执行、目录锁互斥；外部观察 origin=terminal，不应用平台报告或当作 goal 完成；Pi 恢复不宣称并发 TUI 附着。 |
| domain / P19 | Done 的迟到事件 / 评论 / pin 变化，空 Reopen、合法新目标、Resume。 | 保持 Done；空目标拒绝，合法 Reopen 增 targetRevision、新 goal、control=paused，历史不变。 |
| browser/API / P20 | 在相同视口对照只读设计页面 / 弹窗，实际提交和失败、切换对象、搜索 / 偏好 / 统计。 | 布局只有已批准例外；不新增 task / artifact / session 入口，保存真实，输入隔离、去重统计与偏好正确，token 不更新业务排序。 |
| specs/domain / P23 | V2 changes → V3 proposal；单批准 / 单升级、跨 Issue / scope 批准和无关草稿。 | 修订可执行而被拒版本不可实施；新版本独立批准，pin 与批准不可相互推断，适用授权只在准确范围有效。 |
| report/API / P24 | 同 toolCallId 重送、同幂等键异内容、错误 draftRevision / specId / requestId，混入 Agent approve / pin / final。 | 报告原子应用或拒绝，无部分版本 / 请求；原生事实独立保存，同调用只发布一次，宿主不信任自报 runId。 |
| domain/native / P25 | Stop 保存纠正，clear_queue / abort / interrupt 后停止确认丢失；核查后 Resume。 | stopping 与锁保持到准确确认；纠正不成为 stop 任务，原地副作用保留，stopResolved 后上下文只保留业务纠正和历史停止。 |
| worker/store / P26 | 多触发合并，等待期间轮询 / 重启；实际条件恢复；仅 token / 已读 / 草稿变化。 | dirty 与 triggerIds 持久化，旧应用不能清掉新触发；条件恢复才评估，无新事实不重复模型 / 请求 / Run。 |
| migration / P28 | schema2 备份及 session / Run 精确关联；旧同名不同路径、共享来源、文件缺失、不可读、孤立 session、无对应原文批准。 | schema3 原子回填或整体回滚；只在准确来源时去重，missing 标明，不猜身份 / 批准，不释放 unknown 锁或启动 Agent。 |
| worker/native / P29 | Jev 网络 / 429 / 5xx 与401 / 422，超时；明确失败 / 无 JSON / unknown；3轮无进展及8 / 64次、30分钟边界。 | 暂时错误有限重试、认证错误不重试；等待结构可恢复，未知不重放，无 JSON 不冒作失败；限额产生可定位请求，证据来源真实。 |
| HTTP/context / P30 | 同源与跨源写入、同键重试 / 异请求；公开 state、流和两种 prompt，超限输入 / 附件。 | 同源允许、跨源拒绝，同键返回原结果 / 异请求409；无密钥 / 认证泄露，超限错误明确，不静默裁去审批正文。 |

### 11.2 真实端到端验收

P21 必须使用真实 Jev、已认证 Agent、隔离 Git / Worktree 和独立 DATA_DIR：从空系统 Spec 开始，在浏览器 Start，Agent 自主规划并经系统工具发布，Human 批准明确版本及目录升级，随后自动实现与验证，最后由 Human 验收。保留 Evaluation、Issue.sessions、Run 快照、实际代码 / 测试证据及审批引用，证明整条链路无需人工创建后续 tasks。

P22 再使用已有、范围准确的获批版本完成一个可直接实现的目标；证明无需固定 Codex → Pi 顺序、不强制所有绑定执行，也不强制每轮重新编写 Spec。只检查路由符合职责、实际成果覆盖需求，不要求模型每次选择完全相同的步骤。

原生互通单独核验 P18：本地 terminal 通过相同 app-server endpoint / threadId 读到 Relay 历史，暂停 Relay 后在 terminal 新开 turn，Relay 识别 busy 与外部来源；Pi 1.0.0 在 RPC 退出后从相同 sessionFile 恢复。协议 peer 只能证明适配器处理，不能代替真实客户端互通。

### 11.3 现有测试的调整边界

| 现有位置 | 与本版契约的对应 |
| --- | --- |
| tests/core.test.ts：spec CAS、missing bound material、malformed handoff、自动交接链 | 将本地文件 Spec 的断言替换为系统草稿 / 固定版本；自然语言终态必须返回 Triage，完整链不能依赖 Agent 返回 tasks 或空队列验收。报告字段错误仍验证原子拒绝，但不把原生事实清空或强制永久人工阻塞。 |
| tests/core.test.ts：Pi filters reasoning、failure recovery；tests/native.test.ts：session / migration | 改为公开 thinking 流式持久化、共享输入不传 thinking；恢复按结构化条件判定，不能要求 reason 文案。session 从 Issue 记录读取，保留旧迁移测试并新增 schema2 → 3，核验未知运行原锁及历史引用。 |
| tests/activity.test.ts、scripts/browser-test.mjs | 保留单 Run 聚合和独立请求，新增真实增量 / SSE 及生命周期输入；Spec 保存断言改为系统持久化、共享与 CAS，不再要求写本地 docs 文件。布局比较覆盖原设计页面和已批准交互；完整移动端与未批准入口不列为本版验收。 |

构建验证 TypeScript 与生产打包；自动化记录与真实端到端记录分别标明实际执行范围。未执行 P21 / 真实互通时，不能用 mock 或既有测试通过宣称整套目标设计已经验收。
