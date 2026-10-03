# TECH — Relay 多 Agent 协同系统

## 1. 代码组织

根目录是实际应用，`/home/elliot/workspace/tmp/ui-design/src/App.tsx` 是只读视觉依据。Node.js 24 原生 TypeScript 与 SQLite；React 19、Vite、Tailwind 4。`server/store.ts` 管持久化、事务及幂等；`server/domain.ts` 管 Issue、绑定、请求、任务、成果与状态；`server/files.ts` 管 Git 目录验证和 Spec CAS；`server/jev.ts` 只做类型化路由；`server/runtime.ts` 管 Codex/Pi 子进程与执行锁；`server/index.ts` 管 HTTP 与启动恢复；`src/` 管视图、双语、草稿和真实 API。界面不承担审批、路径验证或调度的权威判断。

## 2. 已有设计与边界

产品外部语义完整定义于同目录 product.md §§1–20，A1–A6 沿用文档默认规则。视觉复用 `/home/elliot/workspace/tmp/ui-design/src/index.css` 主题变量与 `App.tsx` 的 SidebarItem、IssuesList、ProjectDetail、BindAgentDialog 和详情布局；不复用 initialIssues、initialProjects、initialInboxItems 或伪成功状态。复用已有本地后端、幂等、锁及交接协议，按 §3.5 迁移旧执行器。原稿 `docs/PRODUCT.md` 保留为输入来源，正式规格以索引为准。

Jev 官方 [HTTP API](https://docs.typesafe.ai/api) 为 POST https://api.typesafe.ai/v1/systemone，Bearer 密钥，body `{model:"jev-latest",state,questions}`，Choice question `{type:"choice",instructions,criteria:{option:description}}`；返回 `answers.<id>.{type,choice,probabilities,confidence}`。Jev 不生成任务/摘要，任务来自用户或 Agent 结构化结果，Jev 仅在现有绑定及 Human 之间选择。记录选择、置信度及候选说明，代码复核权限及状态。

## 3. 实现逻辑

### 3.1 存储与单用户部署

应用绑定 loopback；浏览器访问同源 HTTP，Vite 开发代理到 API，`changeOrigin: false` 保留浏览器页面原始 Host，使代理后的 Origin 与 Host 一致；同源写入允许，其他 Origin 拒绝。单用户本地开发工具，不提供多人认证。请求Host仅接受loopback主机；写操作检查 Origin，JSON body 最大 12MB（附件最大 5MB，base64），不接受任意命令参数。`data/relay.sqlite`（DATA_DIR 可配置）WAL、foreign_keys、busy_timeout。一个服务进程；事务 BEGIN IMMEDIATE 串行提交，异常回滚。SQLite 无需外部数据库。密钥独立写入 `data/secret.json`，目录 0700 文件 0600，不放入状态、事件或 Agent prompt。环境 TYPESAFE_API_KEY 可作为初始配置。

表结构：

- `state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,revision INTEGER NOT NULL)`：JSON 文档是业务 Source of Truth，内含 schemaVersion=2 和实体集合。
- `operations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL)`：同事务存请求摘要和确认结果。同键同请求返回原结果；同键异请求 409 IDEMPOTENCY_CONFLICT。
- `locks(path TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE)`：canonical realpath 的 Worktree 排他锁，跨 Issue 防并发写。异常/unknown 保留锁，人工核查后释放。

业务实体字段（字符串 ID 为 randomUUID，时间 UTC ISO8601；Issue 编号事务递增 REL-1…）：

- Issue `{id,number,title,description,status,createdAt,updatedAt,started,paused,revision,runBudgetStart?,priority:0|1|2|3|4,labels:string[]}`；status 为 Todo/In progress/Human input/Done。正文与 comments 分离。
- Project `{id,name,path,commonDir,health,healthReason,checkedAt}`；Worktree `{id,projectId,name,branch,path,specName,specDir}`，写入者是项目登记服务，归属以 Git common-dir 相等验证；canonical path 唯一。
- Agent `{id,name,command,version,status,heartbeat,reason}`：启动/周期执行 `--version` 可确认安装响应，不能由安装推断认证成功；实际运行认证失败记录 reason。内置工具仅 Codex/Pi，缺失显示 missing。
- Binding `{id,issueId,projectId,worktreeId,agentId,description,revision,removed}`，相同生效 issue/project/worktree/agent 唯一；运行 snapshot 冻结上述四项、实际名称路径。
- Task `{id,issueId,text,status,bindingId?,dependencyIds:string[],sourceId?,requestId?,attempts,createdAt}`；pending/running/waiting/done/cancelled/unknown。依赖 request Approved/Answered 或 task done 后才可执行；取消请求不算通过。问题请求关联 task 与 resume task，用于交接完成后恢复。
- Run `{id,issueId,taskId,bindingId,snapshot,context,status,pid?,sessionId?,nativeTurnId?,startedAt,finishedAt?,result?,reason?}`；starting/running/stopping/completed/failed/stopped/unknown。历史 context 与 snapshot 不随绑定变更；终态重复/晚到事件不重开 Done。
- Event `{id,issueId,source,type,text,at,receivedAt,runId?,taskId?,bindingId?,requestId?,data?}`：原始顺序存储，迟到 at 与 receivedAt 均保留；steps 来自实际 JSONL，不构造内部思考。长输出折叠；每个上报步骤保存最多64KB并标明截断（完整输出在原生工具支持保存时由该工具提供；Relay 对超限事件不承诺完整终端归档），总 prompt 256KB，超限请求人工提供明确材料，不能静默截断必需资料。
- Artifact `{id,issueId,runId?,bindingId?,kind,title,content,version,createdAt,supersedesId?}`：SHA256 内容版本，冻结文本、diff、测试说明；Agent 来源标为未独立验证。新版本显式替代指定旧 artifact 时关联 Pending 请求 Superseded，不因文件草稿变更失效。替代审批所依据的成果时，相关活跃执行进入 stopping，保持旧 context 和写锁，等待确认停止及核查。
- Request `{id,issueId,taskId?,kind,title,body,options?,artifactIds,scope,action,status,answer?,decision?,decidedBy?,decidedAt?,revision,source,recipient,supersedesId?,supersededById?}`；kind input/approval/final，status Pending/Answered/Approved/Changes requested/Superseded/Cancelled。scope 是 task ID 数组或 issue。审批必须引用至少一个可读取冻结 artifact，action 必填。最终验收引用汇总材料。
- Notification `{id,requestId,issueId,category,read,archived,createdAt}`，同请求仅一个通知。读取路径先 notification.requestId 再请求；Archive 不修改 request。
- Comment `{id,issueId,text,createdAt}`；Attachment `{id,issueId,name,mime,content,createdAt}` 保存文本/图片附件 base64，只完成上传后纳入 context。

实体读写按 ID 查找集合；请求/活动按 issueId 过滤，项目统计通过 bindings 去重。此规模是本地单用户工作空间，无跨服务分页承诺。每次变更递增全局 revision，业务事件更新 issue.updatedAt，心跳/读取/token 不更新。schemaVersion 1 启动事务迁移到 2：补充 sessions=[]、Issue priority=0/labels=[]、labelCatalog 默认三项。旧 Run 不猜测原生 ID；旧 unknown 保留及锁。其他版本拒绝启动。

### 3.2 HTTP 契约

GET `/api/state` 返回 `{revision,issues,projects,worktrees,agents,bindings,tasks,runs,events,requests,notifications,artifacts,comments,attachments,sessions,labelCatalog,settings:{configured,testedAt,connection}}`，不返回密钥、Run context及附件二进制；GET `/api/attachments/:id` 返回原附件。GET `/api/health` 返回 `{ok:true}`。轮询 state 2 秒、失败显示连接及最后更新，恢复全量按 ID 更新无重复。GET `/api/directories?path=<absolute>` 列出可访问真实子目录，Browse 通过服务端选择路径。

POST `/api/actions` body `{type:string,payload:object}`，header Idempotency-Key 必填 UUID；所有确认变更返回 `{result:object,revision:number}`。必填字段用非空 trimmed string，title/name<=500、description/task/comment<=100000；ID 必须存在，revision 是非负整数。

动作及 payload：

| type                     | payload                                                                         | result       |
| ------------------------ | ------------------------------------------------------------------------------- | ------------ |
| issue.create             | title,description?,attachments?:{name,mime,content}[]                           | issue        |
| issue.update             | issueId,title?,description?,priority?,labels?,revision                                              | issue        |
| issue.control            | issueId,command(start/pause/resume/stop/final/reopen),text?                     | issue        |
| comment.create           | issueId,text                                                                    | comment      |
| task.create              | issueId,text,bindingId?,dependencyIds?                                          | task         |
| task.cancel / task.retry | taskId,reason                                                                   | task         |
| project.create           | name,path                                                                       | project      |
| worktree.create          | projectId,name,path,branch,specName,specDir                                     | worktree     |
| binding.save             | issueId,id?,projectId,worktreeId,agentId,description,revision?                  | binding      |
| binding.remove           | bindingId,reason                                                                | binding      |
| request.create           | issueId,taskId?,kind,title,body,options?,artifactIds,scope,action,supersedesId? | request      |
| request.decide           | requestId,revision,decision(answer/approve/changes/cancel),answer?              | request      |
| notification.update      | notificationId,read?,archived?                                                  | notification |
| artifact.publish         | issueId,title,kind,content,worktreeId?,supersedesId?                            | artifact     |
| run.reconcile            | runId,outcome(completed/failed/stopped),evidence                                | run          |
| settings.save            | apiKey                                                                          | configured   |
| settings.test            | 无                                                                              | connection   |
| agents.refresh           | 无                                                                              | agents       |

GET `/api/spec?worktreeId=&document=product|tech` 返回 `{content,version,path}`；PUT `/api/spec` body `{worktreeId,document,content,version}` + Idempotency-Key，返回相同结构。空文件 version=SHA256('')，路径严格由登记 specDir 与 PRODUCT.md/TECH.md 拼接，不接受请求任意 filename。规格目录和文件 realpath 必须位于目标 Worktree 内，禁止符号链接逃逸；文件创建不会覆盖已有文档。CAS 在进程内HTTP 变更串行队列（包含文件保存） 下重新读取 hash；请求的 content 已与实际文件一致时直接返回确认结果，可核查写入成功但数据库确认未落盘的重试；否则冲突 409 SPEC_CONFLICT 携带当前 content/version；编辑区保存本地草稿，显示两者，用户明确重新基于最新版本保存。文件原子临时写 rename；外部进程不参与 CAS mutex，保存前 hash 检测且说明仍需避免外部同一瞬间写入，不能宣称分布式锁。

失败统一 `{error:{code,message,details?}}`。400 INVALID_INPUT/MATERIAL_UNREADABLE、404 NOT_FOUND、409 STALE_VERSION/DUPLICATE_BINDING/WORKTREE_BUSY/REQUEST_RESOLVED/DEPENDENCY_BLOCKED/RESULT_UNKNOWN/IDEMPOTENCY_CONFLICT/SPEC_CONFLICT，422 INVALID_REPOSITORY/BRANCH_MISMATCH/PATH_OUTSIDE_WORKTREE，503 JEV_UNAVAILABLE/AGENT_UNAVAILABLE，500 INTERNAL_ERROR 不返回敏感异常文本。失败保留 UI 输入。并发审批由事务内 request.revision + Pending 检查首次提交胜出。

### 3.3 Issue、绑定、控制与状态

创建 Todo 无自动绑定无任务执行。Start 设置 started 并为需求建立一项任务（来源 Issue）；没有绑定或配置创建一次 Human 请求。普通评论不触发新任务。Start 重复不重建任务；pause 阻止新调度不停止现有运行。stop 保存纠正，请求原生 turn/interrupt 或 Pi clear_queue 后 abort，确认原生中断终态才 stopped 释放锁；未确认或重启转 unknown 保留锁。Resume 只重新评估 pending/dependency，不重放历史。reopen 只允许 Done 且非空修订目标，创建新 task。

Issue status 派生：Done 不被迟到事件改变；未 started 为 Todo；started 且 recipient=Human 的有效阻塞 Pending 为 Human input；否则 In progress。每 Issue 同时至多一 active run，全局同 realpath Worktree 至多一 active/unknown run。绑定修改只影响后续；修改 active 绑定不更改 snapshot，UI 显示旧配置。移除取消旧待派安排但保留任务为待重新路由并记录理由，进行中执行必须先停止/核查，避免静默切换。

Final 仅在 Issue 已 Start，且无未完成 task、无有效 Pending/Changes requested 或未被替代的撤销/失效审批阻塞（取消其全部范围任务可明确移除该验收要求）、无 active/unknown run，且至少一个 artifact 才创建 final 请求。批准 final 再次复核这些条件，才 Done。取消 task 需要明确 reason 修改验收范围。审批变化不会解除其他 task dependencies；Changes requested 生成修订任务，旧提案保持阻塞，修订任务通过 sourceId 关联该请求，只豁免正在修订的拒绝对象；修订后显式新版本/新请求。新请求的 supersedesId 指向同 Issue 同 kind 的旧请求，原请求保存 supersededById，未完成任务的对应依赖改指向新请求。旧决定保留且不能批准新版本。最终验收修改后满足完成条件才自动形成替代旧请求的新最终验收。

### 3.4 Triage 与调度

`src/App.tsx` Issue 详情 的需求正文直接接 Activity；不渲染 Submit task、Publish artifact、Request approval、Request human input 工具栏或对应创建弹窗，也不将它们移入更多菜单。Start 通过 `issue.control` 建立初始 task；`Runtime.complete → ingest` 自动持久化 Agent 的成果、请求和后续 task，审批请求自动加入后续 task 的 dependencyIds；`request.decide` 保存 Human 决定，worker 重新评估依赖并经 Jev 选择下一 binding。无待办且满足条件时 worker 自动创建最终验收。人工只能通过现有请求答复/决定和运行控制介入正常轮转；无需调用四类创建操作推进下一步。既有 task.create、artifact.publish、request.create HTTP 契约保留以兼容已有调用；新设计不包含文档版本发布入口，冻结材料由自动交接产生。无结构化/空交接时保留可检查报告并请求核查，提示用户提供纠正目标或核查后重试，不引导用户使用已移除的手工提交入口。

每秒 worker 对 started 非 paused 非 Done 的 Issue 评估待办；inflight Set 阻止同 Issue 重入。已运行/依赖未通过时 wait，不请求 Jev；Worktree锁在选中绑定的启动事务检查，竞争时记录等待并退避60秒。可用绑定选择候选携带实际 Agent 可用性，再发 Choice；选中后校验真实目录、分支、工具和材料（最多254绑定加human），state 包括需求、task、绑定 descriptions、有效决定、成果完整快照、未决请求和上下游。confidence>=0.65 且 choice 是现有 binding 才继续，低置信/冲突/无候选转 Human；原因是选择值及置信度而非伪造模型解释。Human 请求包含明确待办及绑定选项，选中后必须 submit；有效答案绑定已被移除不能派发，重新要求澄清。手动指定绑定仍检验 scope 和 dependencies。

Jev 超时15秒、429/529/5xx/网络最多3次指数退避，记录每次实际尝试，不重试401/422；连接测试同一 endpoint 使用固定无敏感状态。失败记录等待原因不模拟成功，配置保存/恢复后重评估。每 task 最多8次执行、每 run30分钟、每次 Start/Resume 自动推进窗口最多64次实际运行；任务上限变为 waiting 并请求 Human，链式64次上限同时暂停 Issue；明确 Resume 开新窗口，不重放已有任务。Task Retry 在提供核查依据后可重置8次窗口。无进展/相同事项按 task/request ID 去重，不根据文本重复生成。Start/绑定变化/请求决定使对应 waiting任务重新评估；待解请求不反复调用 Jev。

开始前事务复核 issue pause/status、binding revision、task状态、目录和 dependencies，创建 run snapshot/context、插入 locks 同时标 task running。锁失败不启动进程。异步 Jev 返回后使用捕获 revision 比对，过期判断丢弃。

### 3.5 Agent 实际执行、交接与恢复

Codex adapter `server/agents/codex.ts` 管理单个本地 app-server 与 Unix WebSocket，使用 `ws` 的 Unix socket 支持。首次需要执行才启动 `codex app-server --listen unix://<DATA_DIR>/codex.sock`，继承本地 Codex 认证但去除 Jev 密钥，shell=false；`CODEX_APP_SERVER_ENDPOINT` 可指定已运行的本地 Unix 或 loopback ws 服务，该服务不由 Relay 停止。每连接 initialize(clientInfo) 后发送 initialized；响应按请求 ID 关联，处理服务器请求与无 ID 通知。启动/通信超时 15s，关闭 owned 服务先 SIGTERM，5s 后 SIGKILL，不把进程退出当 turn 成功。

持久化 Session `{id,bindingId,agentId,path,threadId?,sessionFile?,endpoint?,version,busyTurnId?,status,createdAt}`，state.sessions 是绑定到原生会话的索引；Run.sessionId 引用该对象，Run.nativeTurnId 为准确 turn ID。绑定 ID、工具、真实目录必须相符才能复用，removed 不能新派发；description 编辑不改原生目录及旧 Run 快照。GET state 暴露这些非密钥元数据；`npm run session -- <bindingId>` 从 API 读取后直接 exec `codex resume --remote <endpoint> <threadId>`（Pi 显示/打开 session 文件，活跃时拒绝）；没有原生历史返回明确错误。

Codex thread/start 使用 cwd、sandbox=workspace-write、approvalPolicy=on-request、ephemeral=false；复用 thread/resume 相同 threadId，不 fork；订阅 thread/status/changed、turn/started、item/completed、turn/completed、serverRequest/resolved。发送新任务前检查 thread/read 的 status 和 active turn，并检查 sessions 中同 issue/worktree 的外部 busy 状态，避免 turn/start 对现有 turn 的 steer 行为。外部活跃 turn 记录 Activity 并持有路径锁，直到明确终态；同目录其他 Issue 也等待。原生 turn/start 返回 ID 立即持久化，通知先于响应时缓冲按 thread/turn 匹配；仅确切 turn.completed 决定完成，agentMessage.text 为最终报告，失败 error/interrupted 分别失败/停止。通知取有限类型和公开输出，reasoning 不落库。断线或启动响应未知转 unknown，不重放。重启时 resume/read 获取准确旧 turn：终态收集已存在结果（只允许一次 ingest）；仍活跃重新挂接等待完成；缺失不释放锁。

Pi adapter `server/agents/pi.ts` 使用版本 1.0.0 随包文档（@earendil-works/pi-coding-agent），`pi --mode rpc --session <DATA_DIR>/pi/<sessionId>.jsonl`，不使用 --print、--no-session 或旧 SDK。stdin/stdout 按 LF JSONL 分帧，ID 关联 response；get_state 返回原生 sessionFile/sessionId；发送 prompt 前监听事件，response success 只是接受，不能作为完成。message_end 的 assistant 文本/stopReason/errorMessage 保存最终内容；agent_end 的 willRetry/压缩/排队不结束 Relay Run，仅 agent_settled 才完成。工具事件记录公开内容，过滤 thinking；clear_queue 后 abort，等待 settled 再确认停止。重启 get_state 打开原文件但不重发 prompt；已有会话记录不足以证明某个未知 Run 已完成，保持 unknown 人工核查。RPC 异常退出/超时保持 unknown 和锁。

原生审批 item/commandExecution/requestApproval、item/fileChange/requestApproval 冻结原生参数为 artifact，并创建当前 Run 范围的 Human approval；请求 native 字段 `{sessionId,rpcId,method,params,delivery?}` 保留关联。输入 item/tool/requestUserInput 或 Pi extension_ui_request 的 select/confirm/input/editor 映射 input/approval 卡，不自动选择。HTTP request.decide 校验活跃连接及原生请求仍 Pending，再提交 Human 决定并答复 accept/decline 或问题答案结构/extension_ui_response；发送未知时标记 delivery unknown，禁止当作已执行。原生 Changes requested 不创建产品修订 task，其 decline/confirm=false 交给原生 Agent 处理。serverRequest/resolved 或 disconnect 不能伪造授权；外部已处理的请求标记 Resolved externally 并记录原生事实，不是业务 Approved。终态清理该 turn 未答复原生请求为 Cancelled/失效，不阻塞后续业务验收。任何不支持的原生阻塞协议冻结材料、转人工并拒绝自动授权。

版本检测仅说明程序响应，认证可用性由实际执行确认。定期探测保留认证失败状态，用户修复外部认证后可通过 agents.refresh API 清除旧失败；新 UI 不加 Refresh 按钮。只记录 JSONL 可见 tool/command/message/result，过滤 reasoning、密钥、Bearer、TOKEN 等，不传密钥到 child env。Agent prompt包含 task、Issue目标、binding范围、指定 spec完整原文、上游artifact、请求/决定、评论附件引用，以及明确授权范围；已有文件不可读先请求材料不执行；尚不存在的文档作为空内容且明确标明路径，允许规格编写任务创建，不声称已阅读缺失文件。解析出的交接先在 State 深拷贝上完整校验，再一起合并事务；无效结果不遗留部分任务/审批，只冻结原文和人工核查请求。输出末尾要求 fenced JSON `{summary,artifacts:[{kind,title,content,supersedesId?}],tasks:[{text,bindingId?,dependencyIds?}],requests:[{kind,title,body,options?,artifactIndexes?,action,scope?,routeToAgent?,supersedesId?}],answer?:{requestId,text}}`，无结构化结果或没有成果、后续任务、请求、问题答复的空交接则原文冻结为 Agent 报告并请求人工判断剩余事项，不能根据exit 0声明需求完成。Agent不能设置 request approved/final或代签；结构化 human请求由 domain服务创建。每个artifact存原输出与来源，测试内容标明Agent报告。代码 diff/commit 和测试输出由 Agent 作为可检查成果上报，不自动计算示例代码统计，也不能将任何输出推断为测试通过。

澄清由 Agent产出 input请求和关联问题task；原task waiting，问题请求 recipient=Agent，路由问题task到另一binding/Human；无法路由则将原请求 recipient 改为 Human、恢复同一通知，不创建重复问题。Human 直接回答后未开始的对应问题任务设为 done；有效 answer关联原request，满足依赖后原task创建新的运行，从共享context恢复。审批请求使相关后续task依赖request，其他独立task可执行；最终批准仍归Human。原生交互桥接按本节，产品审批始终使用独立的冻结材料和依赖。

仅原生终态可确认运行完成；服务停止/连接断开/结果不明保留 unknown 与锁。Domain.recover 先冻结旧活跃 Run，Runtime 按原生精确 ID 恢复，Pi 不自动重发。Human reconcile 需非空现场核查证据，冻结 report 并释放锁；不将旧 exec 运行转换成猜测 thread。终态重复/晚到事件只记历史，不再次 ingest。所有业务请求、成果和决定仍按原有存储恢复。

### 3.6 项目、Spec、附件与偏好

project.create realpath + git rev-parse验证，commonDir确定仓库身份。worktree.create 同commonDir且 branch精确匹配，目录realpath唯一。specDir必须相对无..且不逃逸工作树，登记不创建branch/清空代码。Health定期核查真实路径与branch及未提交变更，存在变更展示 needs attention 和核查提示，不清理用户工作；执行 context 明确要求保留现场，Agent周期刷新版本及最近响应时间，Active runs依据run而非bindings。Browse返回服务端真实目录，上传文件夹不能替代路径。

Spec编辑 draft 按 worktree/document 键，读取已有文件，输入后 600ms 防抖 CAS 自动保存，已有状态位置显示保存结果；冲突停止自动重试并保留草稿，需显式 API 核对后解决。Agent 发布成果独立存数据库固定版本。附件上传成功才成为Issue材料，二进制不虚假转换为已阅读文本：先创建关联任务的Human请求，获得必要内容的文本答复后再执行；纯URL成果拒绝为 MATERIAL_UNREADABLE，必须发布可读正文或快照。主题和语言localStorage，系统文案完整双语，用户文本不翻译。导航hash保存视图，数据始终按实体id关联，评论/请求输入与选择按对象键隔离。列表分组/搜索/项目去重及计数按product §§5/10/11/16；窄屏允许侧栏收起与详情纵向布局。布局完整复用新设计；未展开的高级图标不显示虚假成功，不自行增加可见界面。

## 4. 测试

使用Node test临时SQLite、临时Git仓库和伪JSONL子进程，注入Jev fetch，不执行真实开发任务。浏览器Playwright验证主要导航、真实API与视觉布局。

| 层级                | 场景/前置输入                                                | 预期结果与副作用                                      | 产品验收   |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------- | ---------- |
| domain/API          | 空白title、双创建、同key重复/异请求、刷新                    | 拒绝非法输入、编号唯一、单对象、409冲突               | AC01–03    |
| domain/files        | 两个repo、两个worktree、重复/空description、跨归属/分支错误  | 仅合法四项绑定、项目切换清空、真实路径唯一            | AC04–10/40 |
| worker              | 保存binding未Start、不同descriptions、审批依赖、低confidence | 未启动、具体binding路由、禁止绕审批、Human一次        | AC11–14    |
| runtime             | JSONL多步骤失败重试、部分事件、无验证材料                    | 保存实际步骤尝试，折叠不丢历史，未知不编造            | AC15–17    |
| domain/API/browser  | input选择未提交、approval/final、两入口、Agent answer        | 未提交不变、同请求一致、Human单签、普通approval非Done | AC18–23    |
| domain/API          | superseded、并发决定、read/archive、两阻塞依赖               | 拒绝过期/第二决定，通知不批准，只解除对应依赖         | AC24–27    |
| worker/runtime      | 跨binding问题、缺spec材料、替换activebinding、移除           | 因果关联恢复/请求材料，snapshot不变，旧run确认后切换  | AC28–32    |
| worker/runtime      | paused时approve、unknown重启、同path双Issue                  | 保存决定无派发、保留锁不重放、互斥写入                | AC33–35/39 |
| domain              | 未完成task普通review、final批准迟到、reopen                  | 阻止Done，仅final完成，迟到保留历史，显式修订         | AC36–37    |
| files/browser       | 切页独立draft、外部文件变化、invalid symlink                 | 输入不串页、409保留local/current、不能越目录          | AC38/41    |
| worker/browser | Start后规格绑定交接成果/审批/后续task，Human批准 | 审批前无执行，批准后自动选实现绑定，最终自动送验收；Issue两种语言及更多菜单无四个创建入口 | AC45 |
| integration/browser | 工具缺失、Jev401/429/timeout、搜索多个关联、theme/locale     | 真实状态、有限重试、Issue去重、偏好持久化无密钥       | AC42–44    |

构建 TypeScript 检查、Vite生产build；API smoke真实临时Git目录验证登记/文件保存；浏览器测试创建Issue、绑定、请求两入口、搜索、主题、语言、无示例数据。真实Jev认证与真实Agent端到端执行需要用户在本地配置密钥及工具认证，不能由mock测试声称已通过。

## 5. 验证材料对应

`tests/core.test.ts` 使用临时仓库/数据库验证创建与幂等、绑定归属和快照、审批/归档/并发决定、回答提交、最终验收及修订、版本替代依赖、CAS及路径逃逸、跨Issue写锁和重启、Agent问题交接与Human升级、失败不重放、Jev协议及置信度、过期异步判断、交接原子性、运行次数保护，以及真实可控子进程的JSONL步骤与停止确认。`scripts/browser-test.mjs` 验证真实HTTP与浏览器的空状态、创建/绑定、审批同步、Spec保存及草稿隔离、搜索、偏好和窄屏核心操作。Mock Jev与可控执行器不代表真实模型端到端认证已经验证。

部署及工具授权范围见根目录 `README.md`“执行协议”。实现使用单进程SQLite业务文档，适用于当前本地单用户范围；不提供多实例任务恢复，也不提供第三方编辑器参与的文件分布式锁。

## 6. 新 UI 实现与验收

`src/App.tsx` 直接复用新设计组件/classes 与 CSS，真实 API 数据替换示例，移除旧 Issues/Projects/components 的额外界面。IssuesList、ProjectsList、ProjectDetail、SearchableSelect、BindAgentDialog、InboxPage、AgentPage、SettingsPage 及详情尺寸/层级不重设计。保留双语/主题、草稿、通知共享 ID、CAS 与真实反馈。只允许 product §20 三处补充。issue.update 部分更新 title/description/priority/labels，revision CAS；priority 整数 0–4，labels 非空字符串数组、最多 50 项，每项最多 100 字；labelCatalog 持久化已使用标签，固定默认颜色及新标签绿色与设计一致。

测试新增 native 协议可控 peers：两个真实 Codex app-server 客户端在隔离 CODEX_HOME 和本地模拟 provider 加入相同 thread；不调用真实模型。覆盖通知先于响应、原生审批两入口、外部 resolved、活跃终端等待、启动响应丢失、断线 unknown/锁、精确终态恢复且不重放、所有权关闭；Pi 1.0.0 get_state 实测与 RPC fixture 的 agent_end→重试→agent_settled、stopReason error/aborted、清队列中止、session 文件复用。浏览器对照新设计 source 在相同 viewport 的主要页面、弹窗和亮暗主题，验证审批、真实目录、自动 Spec 保存冲突、优先级/标签与草稿；构建及既有自动轮转测试继续通过。服务测试后停止。
