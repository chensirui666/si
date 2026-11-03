# 页面服务与连接

阅读顺序：本文件 → `src/main.ts` → 公开入口 `src/webserver/index.ts` → `browser-auth.ts` / `protocol.ts` → `test/`。

`WebServer.start()` 安全加载签名文件，装配唯一 Agent，监听 `127.0.0.1:3000` 并返回 `{url,authUrl}`；开发模式额外返回 Vite `/auth` 授权链接。`close()` 停止接入、心跳和所属订阅，释放连接与监听；不会清空 Agent 状态。消息仍只在本进程内存里，进程重启即清空。

`@agent-learning/server` 导出 WebServer；`@agent-learning/server/protocol` 是独立的公开网络类型入口。网页只 `import type`，不加载服务端运行时代码。Server 仅通过 Credentials / Agent 的公开入口使用它们。

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

`AGENT_LEARNING_SERVER_PORT` 可指定监听端口（1–65535）。`AGENT_LEARNING_BROWSER_AUTH_FILE` 仅供自动校验隔离签名文件；不设置时仍固定使用 `~/.agent-learning/browser-auth.json`。进程内 WebServerOptions 可注入临时路径、临时端口、受控时钟和订阅源，以测试真实 HTTP/WS；测试不会访问默认签名文件。

阶段一没有模型接口或消息提交。空快照和受控订阅测试不代表真实模型生成已通过。授权文件的异常和人工恢复步骤见 Credentials README。
