# 页面服务与连接

阅读顺序：本文件 → `src/main.ts` → 公开入口 `src/webserver/index.ts` → `browser-auth.ts` / `protocol.ts` → `test/`。

`WebServer.start()` 安全加载签名文件，装配唯一 Agent，监听 `127.0.0.1:3000` 并返回 `{url,authUrl}`；开发模式额外返回 Vite `/auth` 授权链接。`close()` 停止接入、心跳、凭据文件监听和所属订阅，取消当前模型调用并等候收尾，释放连接；最后一条网络事件不保证送达。消息仍只在本进程内存里，进程重启即清空。

`@agent-learning/server` 导出 WebServer；`@agent-learning/server/protocol` 是独立的公开网络类型入口。网页只 `import type`，不加载服务端运行时代码。Server 仅通过 Credentials、Model、Agent 的公开入口使用它们。

```sh
# 在仓库根安装并构建后
npm --prefix packages/server start
# 开发：根 npm run dev:server，另一终端 npm --prefix web run dev
# 单独检查
npm --prefix packages/server test
```

打开终端打印的完整授权链接。启动令牌只在本次进程生效，可重复交换；浏览器收到 303 后跳到干净地址。Cookie 固定 30 天，不因访问续期，HMAC-SHA256 签名，按地址和端口命名与校验，使用 HttpOnly、SameSite=Strict、Path=/。本服务只监听本机 HTTP，不信任代理传入的 HTTPS 声明。保留签名文件、同地址重启可继续使用旧 Cookie；换签名文件并重启后旧 Cookie 失效。

只接受当前 Node 地址；`--dev` 另外接受固定 `http://127.0.0.1:5173`。Host、Origin、显式 cross-site 在授权前检查；无 Origin 也必须有 Cookie。无效授权 401，不可信目标或来源 403；不提供泛化 CORS。启动令牌响应和页面禁止缓存及 Referer 传播，日志不输出签名密钥或 Cookie。启动链接本身属于访问凭据，不要分享给别人。

连接成功后尚未订阅；收到有效 subscribe 后才读取 Agent。替换订阅先取消旧观察者；非法帧关闭所属连接（1008），源错误关闭所属连接（1011），发送失败或缓冲超过 1MiB 则断开该慢连接以便页面重取快照。每 2 秒检查心跳：前两轮无 Pong 时发送 Ping，第三轮仍未响应则清理；收到 Pong 清零。已有 WS 不会仅因 Cookie 到期被强制关闭。

`AGENT_LEARNING_SERVER_PORT` 可指定监听端口（1–65535）。`AGENT_LEARNING_BROWSER_AUTH_FILE`、`AGENT_LEARNING_MODEL_AUTH_FILE` 仅供自动校验隔离签名与模型文件路径；不设置时仍固定使用 `~/.agent-learning/browser-auth.json`、`~/.agent-learning/auth.json`。环境变量不能提供 Key。进程内 WebServerOptions 的 `browserSecretPath/modelAuthPath` 可注入临时路径，另可注入临时端口、受控时钟和订阅源，以测试真实 HTTP/WS；测试不会访问默认用户文件。

阶段二提供 `GET /api/models`、`PUT /api/providers/deepseek`（JSON `{apiKey:string}`）与 `DELETE /api/providers/deepseek`。成功均返回 ModelDiscovery，无 Key；配置通知 `{type:'models_changed'}` 发送给所有连接，不占用 Agent 序号。错误采用 JSON `{error:string}`；输入错误 400、请求过大 413、媒体类型错误 415、文件更新失败 500，授权和来源仍分别是 401/403。保存、替换、删除与外部文件变化均刷新，文件坏掉仍可授权进入设置。

`POST /api/messages` 接收 JSON `{clientMessageId,modelId,text}`，成功返回 202 和 `{clientMessageId,userMessageId,acceptedSeq}`，不等首片段。无效输入 400、忙碌 409；请求上限 64KiB、媒体类型与授权规则沿用配置接口。Key 在接收后由 Model 读取，凭据失败成为正式失败回复，不回滚 user。WebServer 与 Model 共用同一个 Credentials；生成更新由 Agent 内部订阅经 WS 转发，不维护第二份内容。

生产入口固定请求 DeepSeek；进程内 `modelOptions` 可注入 fetch/baseURL 让测试穿过真实 SDK/SSE，main 不提供服务商地址的环境变量覆盖。配置保存只验证本地格式，真实调用才验证远端 Key。授权文件的异常和人工恢复步骤见 Credentials README。
