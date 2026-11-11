# 页面服务与连接

阅读顺序：本文件 → `src/main.ts` → 公开入口 `src/webserver/index.ts` → `browser-auth.ts` / `protocol.ts` → `test/`。

`WebServer.start()` 安全加载签名文件，取得 SQLite 会话库的独占接管权，监听 `127.0.0.1:3000` 并返回 `{url,authUrl}`；开发模式额外返回 Vite `/auth` 授权链接。`close()` 停止接入、心跳、凭据文件监听和所属订阅，取消各会话的模型和工具任务，等待收尾并删除服务临时文件，最后释放会话库和网络连接。会话记录默认写入 `~/.agent-learning/sessions.sqlite`。

`@agent-learning/server` 导出 WebServer；`@agent-learning/server/protocol` 是独立的公开网络类型入口。网页只 `import type`，不加载服务端运行时代码。Server 仅通过 Credentials、Model、Coding Agent 的公开入口使用它们。

```sh
# 在仓库根安装并构建后
npm --prefix packages/server start
# 开发：根 npm run dev:server，另一终端 npm --prefix web run dev
# 单独检查
npm --prefix packages/server test
```

打开终端打印的完整授权链接。启动令牌只在本次进程生效，可重复交换；浏览器收到 303 后跳到干净地址。Cookie 固定 30 天，不因访问续期，HMAC-SHA256 签名，按地址和端口命名与校验，使用 HttpOnly、SameSite=Strict、Path=/。本服务只监听本机 HTTP，不信任代理传入的 HTTPS 声明。保留签名文件、同地址重启可继续使用旧 Cookie；换签名文件并重启后旧 Cookie 失效。

只接受当前 Node 地址；`--dev` 另外接受固定 `http://127.0.0.1:5173`。Host、Origin、显式 cross-site 在授权前检查；无 Origin 也必须有 Cookie。无效授权 401，不可信目标或来源 403；不提供泛化 CORS。启动令牌响应和页面禁止缓存及 Referer 传播，日志不输出签名密钥或 Cookie。启动链接本身属于访问凭据，不要分享给别人。

连接成功后尚未订阅。`subscribe` 指定 `sessionId` 和 `subscriptionId`，快照和更新同时返回这两个编号。替换订阅先释放旧观察者。找不到会话或无法完整读取时返回带编号的 `subscription_error`，原连接可继续订阅。非法帧关闭所属连接（1008），源错误关闭所属连接（1011）。同一连接等待一帧发送回调完成，再发送下一帧，避免正常大快照被紧随的更新误判为慢连接；配置通知按种类合并，同一连接最多按变更种类各保留一条通知。发送失败则清理；每 2 秒检查超过 1MiB 的积压和心跳：前两轮无 Pong 时发送 Ping，第三轮仍未响应则清理，收到 Pong 清零。清理页面连接不取消后台任务。已有 WS 不会仅因 Cookie 到期被强制关闭。

`AGENT_LEARNING_SERVER_PORT` 可指定监听端口（1–65535）。`AGENT_LEARNING_BROWSER_AUTH_FILE`、`AGENT_LEARNING_MODEL_AUTH_FILE` 仅供自动校验隔离签名与模型文件路径；不设置时仍固定使用 `~/.agent-learning/browser-auth.json`、`~/.agent-learning/auth.json`。环境变量不能提供 Key。进程内 WebServerOptions 的 `browserSecretPath/modelAuthPath` 可注入临时路径，另可注入临时端口、受控时钟和会话工厂，以测试真实 HTTP/WS；测试不会访问默认用户文件。

阶段二提供 `GET /api/models`、`PUT /api/providers/deepseek`（JSON `{apiKey:string}`）与 `DELETE /api/providers/deepseek`。成功均返回 ModelDiscovery，无 Key；配置通知 `{type:'models_changed'}` 发送给所有连接，不占用 会话序号。错误采用 JSON `{error:string}`；输入错误 400、请求过大 413、媒体类型错误 415、文件更新失败 500，授权和来源仍分别是 401/403。保存、替换、删除与外部文件变化均刷新，文件坏掉仍可授权进入设置。

`GET /api/sessions` 返回 `{sessions}`，`POST /api/sessions` 接收 `{workspaceId}` 并返回 201 和新的会话摘要。工作区无效或不可用时返回 409。成功新建后用 `sessions_changed` 通知连接的网页。

`POST /api/sessions/start` 接收 `{workspaceId,clientMessageId,modelId,text}`，首条消息被接收后才登记会话，返回 202 和 `{session,accepted}`。`clientMessageId` 是网页为这次首发生成的 UUID，也是会话编号。会话登记、用户消息和任务开始一起写入。重启前后，用同一编号、工作区、模型和原文重试都会返回原回执。新会话的首发必须是普通消息。

`POST /api/messages` 接收 `{clientMessageId,modelId,text,sessionId}`。普通消息成功返回 202 和 `{kind:'message',sessionId,clientMessageId,userMessageId,acceptedSeq}`。`/compact` 的回执类型为 `compaction`，使用 `compactionId`，压缩记录单独显示。格式错误 400、会话不存在 404、会话忙碌或工作区不可用 409。凭据失败通过正式失败回复或压缩失败记录返回。确认已回滚的保存失败返回 HTTP 507 和 `code: save_rejected`。保存状态无法确认时返回 HTTP 500 和 `code: save_unconfirmed`。生成更新由目标 `AgentSession` 经 WebSocket 转发。

`POST /api/abort` 接收 JSON `{sessionId,runId}`（非空且最长 128 字符），沿用来源、Cookie、64KiB 与媒体类型校验。普通任务的运行编号为其用户消息编号，独立压缩为压缩记录编号。等待对应会话运行收尾后返回 HTTP 200 和 `{sessionId,runId,handled}`；目标已结束时 handled=false，不取消其他运行。无需重新验证模型凭据或工作区，HTTP 与订阅断开不撤销已交付的中止。只读会话替身可省略 abort，此时返回 503；内部异常返回脱敏的 500。实际结束记录和空闲状态仍由订阅提供。

生产入口固定请求 DeepSeek；进程内 `modelOptions` 可注入 fetch/baseURL 让测试穿过真实 SDK/SSE，main 不提供服务商地址的环境变量覆盖。配置保存只验证本地格式，真实调用才验证远端 Key。授权文件的异常和人工恢复步骤见 Credentials README。

快照增加 `compactions` 和 `contextUsage`，增量沿同一序号传递压缩记录与容量。摘要、有效消息边界和记录归 `AgentSession` 管理。会话恢复时从同一读取事务取得记录。快照和增量同步任务终态与本进程已知的保存失败。进程内 `WebServerOptions.compaction` 可用 `{triggerTokens,keepRecentTokens}` 降低受控测试预算，由 `AgentSession` 验证；测试可通过 `WebServerOptions.sessionPath` 使用临时会话库。

工作区由 `GET /api/workspaces` 查询。网页通过无请求体的 `POST /api/workspaces/pick` 打开 macOS 系统选择框。服务以真实绝对路径去重，选中时返回 `{cancelled:false,workspaceId,created,view}`，取消时返回 `{cancelled:true}`。旧登记编号和路径继续可读。测试可通过 `workspacePath`、`directoryPicker` 注入隔离的配置和选择器。

`GET/PUT /api/web/settings` 查看或保存两个网页能力的服务商选择。`PUT/DELETE /api/web/providers/:providerId` 管理该厂商的本机 Key。响应只含状态。网页工具用 `web_settings_changed` 通知页面刷新，工作区用 `workspaces_changed`。测试可注入 `webSettingsPath` 和 `webProviders`。

任务更新中，工具结果 `message` 与 `messageIndex` 成对提供，网页按位置插入；`running.kind:'task'` 的 `activeTools` 可以包含多个同时执行的工具，阶段为 model、tools 或 compaction。独立压缩使用 `kind:'compaction'`，只有运行编号和压缩阶段。网页与后台需一起更新，旧页面需刷新。工具的明确取消错误使用 `code: interrupted`；命令超时、失败和成功已确定后，不被后来的取消覆盖，部分输出继续保留。
