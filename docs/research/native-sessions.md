# 原生会话调研（2026-10-03）

实现契约以 specs/relay-collaboration 为准，本文件只记录可复现依据。

- 本机 Codex `0.160.0`：`codex app-server --help`、`codex resume --help` 及 `codex app-server generate-ts --experimental` 生成的 Thread/Turn/审批类型已核对。
- 官方 [app-server 文档](https://learn.chatgpt.com/docs/app-server) 支持 Unix/WebSocket 与 remote TUI，初始化后通过 thread/start、thread/resume、turn/start 与通知交互。
- 隔离 CODEX_HOME、Unix socket 与本地模拟 HTTP provider 实测：首个客户端 start thread 并发起 turn，第二个独立客户端 resume 返回完全相同 threadId。没有调用真实模型。仅 start 尚无首轮 rollout 的 thread，第二客户端可能报 no rollout found，不据此宣称会话已可恢复。
- turn/start 可能对活跃 turn 发出 steer，派发前必须查询状态并等待；进程 exit 不是原生 turn 成功。
- 本机 Pi `1.0.0`，包为 `@earendil-works/pi-coding-agent`；阅读该版本随包 docs/rpc.md、rpc-commands.md、rpc-extension-ui.md、sessions.md、cli-integration.md、json.md，未使用旧 @mariozechner 文档。
- 隔离 Pi 目录实测 `pi --mode rpc --offline --session <file>` 的 get_state 成功返回 sessionFile/sessionId，不调用模型。prompt response 仅表示接受，agent_end 后仍可能重试/压缩，agent_settled 才是全部结束；停止需 clear_queue 后 abort。
- UI 依据 `/home/elliot/workspace/tmp/ui-design/src/App.tsx` SHA256 `6d0161cff9e30d5de0e0ee66aaab6a414edece5176f4137a0ffa2d31f3b336fd`，CSS SHA256 `cc23c3459d6afa8e9182e7c65f83752c6371a4e0b46537f2f85335bb7e951dc8`。三项 UI 补充已由用户确认，见 PRODUCT §20。
