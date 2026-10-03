# TECH — Relay 多 Agent 协同系统

## 1. 代码组织

根目录是实际应用，`docs/ui-design/src/App.tsx` 是只读视觉依据。Node.js 24 原生 TypeScript 与 SQLite；React 19、Vite、Tailwind 4。`server/store.ts` 管持久化、事务及幂等；`server/domain.ts` 管 Issue、绑定、请求、任务、成果与状态；`server/files.ts` 管 Git 目录验证和 Spec CAS；`server/jev.ts` 只做类型化路由；`server/runtime.ts` 管 Codex/Pi 子进程与执行锁；`server/index.ts` 管 HTTP 与启动恢复；`src/` 管视图、双语、草稿和真实 API。界面不承担审批、路径验证或调度的权威判断。

## 2. 已有设计与边界

产品外部语义完整定义于同目录 product.md §§1–18，A1–A6 沿用文档默认规则。视觉复用 `docs/ui-design/src/index.css` 主题变量与 `App.tsx` 的 SidebarItem、IssuesList、ProjectDetail、BindAgentDialog 和详情布局；不复用 initialIssues、initialProjects、initialInboxItems 或伪成功状态。没有既有后端、表或协议；不存在旧接口迁移。原稿 `docs/PRODUCT.md` 保留为输入来源，正式规格以索引为准。

Jev 官方 [HTTP API](https://docs.typesafe.ai/api) 为 POST https://api.typesafe.ai/v1/systemone，Bearer 密钥，body `{model:"jev-latest",state,questions}`，Choice question `{type:"choice",instructions,criteria:{option:description}}`；返回 `answers.<id>.{type,choice,probabilities,confidence}`。Jev 不生成任务/摘要，任务来自用户或 Agent 结构化结果，Jev 仅在现有绑定及 Human 之间选择。记录选择、置信度及候选说明，代码复核权限及状态。

## 3. 实现逻辑

### 3.1 存储与单用户部署

应用绑定 loopback；浏览器访问同源 HTTP，Vite 开发代理到 API，`changeOrigin: false` 保留浏览器页面原始 Host，使代理后的 Origin 与 Host 一致；同源写入允许，其他 Origin 拒绝。单用户本地开发工具，不提供多人认证。请求Host仅接受loopback主机；写操作检查 Origin，JSON body 最大 12MB（附件最大 5MB，base64），不接受任意命令参数。`data/relay.sqlite`（DATA_DIR 可配置）WAL、foreign_keys、busy_timeout。一个服务进程；事务 BEGIN IMMEDIATE 串行提交，异常回滚。SQLite 无需外部数据库。密钥独立写入 `data/secret.json`，目录 0700 文件 0600，不放入状态、事件或 Agent prompt。环境 TYPESAFE_API_KEY 可作为初始配置。

表结构：

- `state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,revision INTEGER NOT NULL)`：JSON 文档是业务 Source of Truth，内含 schemaVersion=1 和实体集合。
- `operations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL)`：同事务存请求摘要和确认结果。同键同请求返回原结果；同键异请求 409 IDEMPOTENCY_CONFLICT。
- `locks(path TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE)`：canonical realpath 的 Worktree 排他锁，跨 Issue 防并发写。异常/unknown 保留锁，人工核查后释放。

业务实体字段（字符串 ID 为 randomUUID，时间 UTC ISO8601；Issue 编号事务递增 REL-1…）：

- Issue `{id,number,title,description,status,createdAt,updatedAt,started,paused,revision,runBudgetStart?}`；status 为 Todo/In progress/Human input/Done。正文与 comments 分离。
- Project `{id,name,path,commonDir,health,healthReason,checkedAt}`；Worktree `{id,projectId,name,branch,path,specName,specDir}`，写入者是项目登记服务，归属以 Git common-dir 相等验证；canonical path 唯一。
- Agent `{id,name,command,version,status,heartbeat,reason}`：启动/周期执行 `--version` 可确认安装响应，不能由安装推断认证成功；实际运行认证失败记录 reason。内置工具仅 Codex/Pi，缺失显示 missing。
- Binding `{id,issueId,projectId,worktreeId,agentId,description,revision,removed}`，相同生效 issue/project/worktree/agent 唯一；运行 snapshot 冻结上述四项、实际名称路径。
- Task `{id,issueId,text,status,bindingId?,dependencyIds:string[],sourceId?,requestId?,attempts,createdAt}`；pending/running/waiting/done/cancelled/unknown。依赖 request Approved/Answered 或 task done 后才可执行；取消请求不算通过。问题请求关联 task 与 resume task，用于交接完成后恢复。
- Run `{id,issueId,taskId,bindingId,snapshot,context,status,pid?,startedAt,finishedAt?,result?,reason?}`；starting/running/stopping/completed/failed/stopped/unknown。历史 context 与 snapshot 不随绑定变更；终态重复/晚到事件不重开 Done。
- Event `{id,issueId,source,type,text,at,receivedAt,runId?,taskId?,bindingId?,requestId?,data?}`：原始顺序存储，迟到 at 与 receivedAt 均保留；steps 来自实际 JSONL，不构造内部思考。长输出折叠；每个上报步骤保存最多64KB并标明截断（完整输出在原生工具支持保存时由该工具提供；Relay 对超限事件不承诺完整终端归档），总 prompt 256KB，超限请求人工提供明确材料，不能静默截断必需资料。
- Artifact `{id,issueId,runId?,bindingId?,kind,title,content,version,createdAt,supersedesId?}`：SHA256 内容版本，冻结文本、diff、测试说明；Agent 来源标为未独立验证。新版本显式替代指定旧 artifact 时关联 Pending 请求 Superseded，不因文件草稿变更失效。替代审批所依据的成果时，相关活跃执行进入 stopping，保持旧 context 和写锁，等待确认停止及核查。
- Request `{id,issueId,taskId?,kind,title,body,options?,artifactIds,scope,action,status,answer?,decision?,decidedBy?,decidedAt?,revision,source,recipient,supersedesId?,supersededById?}`；kind input/approval/final，status Pending/Answered/Approved/Changes requested/Superseded/Cancelled。scope 是 task ID 数组或 issue。审批必须引用至少一个可读取冻结 artifact，action 必填。最终验收引用汇总材料。
- Notification `{id,requestId,issueId,category,read,archived,createdAt}`，同请求仅一个通知。读取路径先 notification.requestId 再请求；Archive 不修改 request。
- Comment `{id,issueId,text,createdAt}`；Attachment `{id,issueId,name,mime,content,createdAt}` 保存文本/图片附件 base64，只完成上传后纳入 context。

实体读写按 ID 查找集合；请求/活动按 issueId 过滤，项目统计通过 bindings 去重。此规模是本地单用户工作空间，无跨服务分页承诺。每次变更递增全局 revision，业务事件更新 issue.updatedAt，心跳/读取/token 不更新。schemaVersion 不兼容拒绝启动；新部署无历史回填。

### 3.2 HTTP 契约

GET `/api/state` 返回 `{revision,issues,projects,worktrees,agents,bindings,tasks,runs,events,requests,notifications,artifacts,comments,attachments,settings:{configured,testedAt,connection}}`，不返回密钥、Run context及附件二进制；GET `/api/attachments/:id` 返回原附件。GET `/api/health` 返回 `{ok:true}`。轮询 state 2 秒、失败显示连接及最后更新，恢复全量按 ID 更新无重复。GET `/api/directories?path=<absolute>` 列出可访问真实子目录，Browse 通过服务端选择路径。

POST `/api/actions` body `{type:string,payload:object}`，header Idempotency-Key 必填 UUID；所有确认变更返回 `{result:object,revision:number}`。必填字段用非空 trimmed string，title/name<=500、description/task/comment<=100000；ID 必须存在，revision 是非负整数。

动作及 payload：

| type                     | payload                                                                         | result       |
| ------------------------ | ------------------------------------------------------------------------------- | ------------ |
| issue.create             | title,description?,attachments?:{name,mime,content}[]                           | issue        |
| issue.update             | issueId,title,description,revision                                              | issue        |
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

创建 Todo 无自动绑定无任务执行。Start 设置 started 并为需求建立一项任务（来源 Issue）；没有绑定或配置创建一次 Human 请求。普通评论不触发新任务。Start 重复不重建任务；pause 阻止新调度不停止现有运行。stop 保存纠正，发送进程组 SIGTERM，5秒后 SIGKILL，只有 close 后 stopped 释放锁；未确认或重启转 unknown 保留锁。Resume 只重新评估 pending/dependency，不重放历史。reopen 只允许 Done 且非空修订目标，创建新 task。

Issue status 派生：Done 不被迟到事件改变；未 started 为 Todo；started 且 recipient=Human 的有效阻塞 Pending 为 Human input；否则 In progress。每 Issue 同时至多一 active run，全局同 realpath Worktree 至多一 active/unknown run。绑定修改只影响后续；修改 active 绑定不更改 snapshot，UI 显示旧配置。移除取消旧待派安排但保留任务为待重新路由并记录理由，进行中执行必须先停止/核查，避免静默切换。

Final 仅在 Issue 已 Start，且无未完成 task、无有效 Pending/Changes requested 或未被替代的撤销/失效审批阻塞（取消其全部范围任务可明确移除该验收要求）、无 active/unknown run，且至少一个 artifact 才创建 final 请求。批准 final 再次复核这些条件，才 Done。取消 task 需要明确 reason 修改验收范围。审批变化不会解除其他 task dependencies；Changes requested 生成修订任务，旧提案保持阻塞，修订任务通过 sourceId 关联该请求，只豁免正在修订的拒绝对象；修订后显式新版本/新请求。新请求的 supersedesId 指向同 Issue 同 kind 的旧请求，原请求保存 supersededById，未完成任务的对应依赖改指向新请求。旧决定保留且不能批准新版本。最终验收修改后满足完成条件才自动形成替代旧请求的新最终验收。

### 3.4 Triage 与调度

每秒 worker 对 started 非 paused 非 Done 的 Issue 评估待办；inflight Set 阻止同 Issue 重入。已运行/依赖未通过时 wait，不请求 Jev；Worktree锁在选中绑定的启动事务检查，竞争时记录等待并退避60秒。可用绑定选择候选携带实际 Agent 可用性，再发 Choice；选中后校验真实目录、分支、工具和材料（最多254绑定加human），state 包括需求、task、绑定 descriptions、有效决定、成果完整快照、未决请求和上下游。confidence>=0.65 且 choice 是现有 binding 才继续，低置信/冲突/无候选转 Human；原因是选择值及置信度而非伪造模型解释。Human 请求包含明确待办及绑定选项，选中后必须 submit；有效答案绑定已被移除不能派发，重新要求澄清。手动指定绑定仍检验 scope 和 dependencies。

Jev 超时15秒、429/529/5xx/网络最多3次指数退避，记录每次实际尝试，不重试401/422；连接测试同一 endpoint 使用固定无敏感状态。失败记录等待原因不模拟成功，配置保存/恢复后重评估。每 task 最多8次执行、每 run30分钟、每次 Start/Resume 自动推进窗口最多64次实际运行；任务上限变为 waiting 并请求 Human，链式64次上限同时暂停 Issue；明确 Resume 开新窗口，不重放已有任务。Task Retry 在提供核查依据后可重置8次窗口。无进展/相同事项按 task/request ID 去重，不根据文本重复生成。Start/绑定变化/请求决定使对应 waiting任务重新评估；待解请求不反复调用 Jev。

开始前事务复核 issue pause/status、binding revision、task状态、目录和 dependencies，创建 run snapshot/context、插入 locks 同时标 task running。锁失败不启动进程。异步 Jev 返回后使用捕获 revision 比对，过期判断丢弃。

### 3.5 Agent 实际执行、交接与恢复

Codex：`codex exec --json --sandbox workspace-write -C <realpath> -`，stdin 传 context。Pi：`pi --mode json --print --no-session -- <context>`，cwd realpath。spawn shell=false，不拼接 shell 字符串。Codex sandbox 维持本地工具权限；Pi 运行进程具备宿主用户权限，prompt 约束不等于 OS 隔离，部署需使用受控本地用户/环境，绑定只控制调度目录，不声称隔离恶意工具。

版本检测仅说明程序响应，认证可用性由实际执行确认。定期探测保留认证失败状态，用户修复外部认证后手动 Refresh 清除旧失败并允许新执行检查。只记录 JSONL 可见 tool/command/message/result，过滤 reasoning、密钥、Bearer、TOKEN 等，不传密钥到 child env。Agent prompt包含 task、Issue目标、binding范围、指定 spec完整原文、上游artifact、请求/决定、评论附件引用，以及明确授权范围；已有文件不可读先请求材料不执行；尚不存在的文档作为空内容且明确标明路径，允许规格编写任务创建，不声称已阅读缺失文件。解析出的交接先在 State 深拷贝上完整校验，再一起合并事务；无效结果不遗留部分任务/审批，只冻结原文和人工核查请求。输出末尾要求 fenced JSON `{summary,artifacts:[{kind,title,content,supersedesId?}],tasks:[{text,bindingId?,dependencyIds?}],requests:[{kind,title,body,options?,artifactIndexes?,action,scope?,routeToAgent?,supersedesId?}],answer?:{requestId,text}}`，无结构化结果或没有成果、后续任务、请求、问题答复的空交接则原文冻结为 Agent 报告并请求人工判断剩余事项，不能根据exit 0声明需求完成。Agent不能设置 request approved/final或代签；结构化 human请求由 domain服务创建。每个artifact存原输出与来源，测试内容标明Agent报告。代码 diff/commit 和测试输出由 Agent 作为可检查成果上报，不自动计算示例代码统计，也不能将任何输出推断为测试通过。

澄清由 Agent产出 input请求和关联问题task；原task waiting，问题请求 recipient=Agent，路由问题task到另一binding/Human；无法路由则将原请求 recipient 改为 Human、恢复同一通知，不创建重复问题。Human 直接回答后未开始的对应问题任务设为 done；有效 answer关联原request，满足依赖后原task创建新的运行，从共享context恢复。审批请求使相关后续task依赖request，其他独立task可执行；最终批准仍归Human。工具无法提供原生交互审批时运行失败/受阻并呈现实际输出，用户通过明确 scoped action 请求决策，不模拟原生批准。

run停止close才确认；异常退出保存失败和实际输出、不自动重复可能已写入的工作；Human reconcile必须非空核查证据，作为冻结 report 保存，unknown不自动再跑。服务重启将starting/running/stopping改unknown，task unknown并保留锁；展示旧pid/结果，用户核查宿主现场后确认状态。Pending requests/artifacts/decisions恢复原样。运行恢复不依赖原生会话存在。Done迟到事件仅追加history。轮询断线保留本地状态并提示。

### 3.6 项目、Spec、附件与偏好

project.create realpath + git rev-parse验证，commonDir确定仓库身份。worktree.create 同commonDir且 branch精确匹配，目录realpath唯一。specDir必须相对无..且不逃逸工作树，登记不创建branch/清空代码。Health定期核查真实路径与branch及未提交变更，存在变更展示 needs attention 和核查提示，不清理用户工作；执行 context 明确要求保留现场，Agent周期刷新版本及最近响应时间，Active runs依据run而非bindings。Browse返回服务端真实目录，上传文件夹不能替代路径。

Spec编辑draft按worktree/document键，读取已有文件，显式Save，发布是独立操作以数据库存固定版本。附件上传成功才成为Issue材料，二进制不虚假转换为已阅读文本：先创建关联任务的Human请求，获得必要内容的文本答复后再执行；纯URL成果拒绝为 MATERIAL_UNREADABLE，必须发布可读正文或快照。主题和语言localStorage，系统文案完整双语，用户文本不翻译。导航hash保存视图，数据始终按实体id关联，评论/请求输入与选择按对象键隔离。列表分组/搜索/项目去重及计数按product §§5/10/11/16；窄屏允许侧栏收起与详情纵向布局。所有未纳入范围入口隐藏。

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
| integration/browser | 工具缺失、Jev401/429/timeout、搜索多个关联、theme/locale     | 真实状态、有限重试、Issue去重、偏好持久化无密钥       | AC42–44    |

构建 TypeScript 检查、Vite生产build；API smoke真实临时Git目录验证登记/文件保存；浏览器测试创建Issue、绑定、请求两入口、搜索、主题、语言、无示例数据。真实Jev认证与真实Agent端到端执行需要用户在本地配置密钥及工具认证，不能由mock测试声称已通过。

## 5. 验证材料对应

`tests/core.test.ts` 使用临时仓库/数据库验证创建与幂等、绑定归属和快照、审批/归档/并发决定、回答提交、最终验收及修订、版本替代依赖、CAS及路径逃逸、跨Issue写锁和重启、Agent问题交接与Human升级、失败不重放、Jev协议及置信度、过期异步判断、交接原子性、运行次数保护，以及真实可控子进程的JSONL步骤与停止确认。`scripts/browser-test.mjs` 验证真实HTTP与浏览器的空状态、创建/绑定、审批同步、Spec保存及草稿隔离、搜索、偏好和窄屏核心操作。Mock Jev与可控执行器不代表真实模型端到端认证已经验证。

部署及工具授权范围见根目录 `README.md`“执行协议”。实现使用单进程SQLite业务文档，适用于当前本地单用户范围；不提供多实例任务恢复，也不提供第三方编辑器参与的文件分布式锁。
