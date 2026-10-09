# AGT-002：Agent 绑定工作目录

设计已确认：[Figma 审阅页](https://www.figma.com/design/RfuMz07kH8mSoAhEMmRpFG/Catcoon?node-id=115-821)、[绑定弹窗](https://www.figma.com/design/RfuMz07kH8mSoAhEMmRpFG/Catcoon?node-id=46-950)。

## 绑定与保存

在 Agent description 和 Approval level 之间新增必填的 `Working directory`。新建绑定时预填项目目录：优先使用 `AGENT_WORKSPACE`，未配置时使用服务启动目录。默认目录不可获取时显示空输入和绝对路径示例，占位符不作为有效目录。

每个 Agent 独立保存目录，切换 runtime 保留用户输入。首次执行前可编辑已保存的目录；保存成功后关闭弹窗并更新绑定卡片，绑定操作不会启动 Agent。取消或关闭弹窗放弃未保存的修改。

## 校验与反馈

目录必须是 Agent 运行机器上已存在、可读取和进入的绝对路径，由服务端校验。默认预填目录也需要校验。

| 情况 | 字段提示 |
| --- | --- |
| 空值或纯空格 | `Working directory is required.` |
| 非绝对路径 | `Enter an absolute path on the agent’s machine.` |
| 目录不存在 | `Directory not found. Enter an existing directory.` |
| 路径指向文件 | `This path is a file. Enter a directory.` |
| 目录不可访问 | `The agent cannot access this directory.` |

空值或非绝对路径禁止提交。服务端校验失败时，在目录字段下显示错误并保留整个表单；失败操作不修改已保存的绑定。提交期间禁用输入、保存和取消操作，按钮显示 `Binding…` 或 `Saving…`。

## 会话与目录锁定

已有会话或执行历史后，工作目录只读，API 同样禁止修改。提示为 `This session uses the saved directory. Bind a new agent to choose another directory.`

目录属于会话执行上下文。保留旧会话却修改目录，会让后续任务和既有历史指向不同工作区，因此选择另一目录需要新建绑定。执行失败、尚未生成会话 ID 的绑定也保留执行历史并锁定目录。

职责和审批级别沿用已有编辑规则；执行中禁止编辑，有未决原生请求时先处理请求。已锁定目录即使后来不可用，也不阻止保存职责和审批级别。

## 展示与布局

绑定卡片在职责下方以次要文字展示保存的目录，长路径换行，悬停可查看完整路径，保留原有审批级别和 Edit 入口。

沿用现有组件、字体和样式。标准绑定弹窗宽 560px、高 625px，内边距 28px；高度可随提示内容调整。小屏幕保持至少 16px 视口边距，内容可滚动。
