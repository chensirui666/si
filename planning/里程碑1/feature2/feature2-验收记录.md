# Feature2 验收记录

日期：2026-11-03。范围：**阶段一：打开、授权与订阅**。阶段二模型凭据设置、阶段三真实聊天与生成中恢复尚未实现或验收。

阶段一已在独立分支完成实现与本阶段自动验收，尚未提交、推送或合并。当前交付：安全授权打开本地页面，建立 WebSocket，订阅唯一 Agent 的真实初始空快照，刷新、断线、离线和服务重启后恢复连接；草稿仍可编辑，聊天发送始终关闭。

## 交付位置与环境

- worktree：`/Users/stardust/agent learning/.worktrees/feature2-stage1`。
- 分支：`codex/feature2-stage1`；起点 `973618e`（main）。worktree 位于项目内部，不在 Codex worktrees 目录。
- 原 checkout 的源码和 Git 工作区保持干净；仅在原仓库本地 `.git/info/exclude` 加入 `/.worktrees/`，避免递归跟踪。
- Node.js `v24.16.0`，npm `11.13.0`，TypeScript `5.9.3`，Playwright `1.62.1` / Chromium。
- 根 npm workspace 管理四个后端包及 web，根 package-lock.json 取代 web 独立锁。逐项比较旧锁已有依赖，版本变化为 0；新增运行依赖 ws 固定为 `8.22.1`。

实施依据：[阶段一设计](./feature2-阶段一-打开授权与订阅.md)、[实施计划](./feature2-阶段一-实施计划.md)、[总体契约](./feature2-单会话流式聊天技术设计.md)。实施方案、关键边界与风险已在实施前获用户确认。

## 最终命令与结果

在本 worktree 根执行：

```sh
npm ci
npm test
npm audit --json
git diff --check
```

| 检查 | 实际结果 |
| --- | --- |
| 根锁文件重新安装 | npm ci 成功，未使用旧网页 node_modules |
| 后端四包构建 | Credentials → Model → Agent → Server，全部成功 |
| 前端构建 | TypeScript 检查与 Vite 生产打包成功 |
| Credentials 文件系统集成 | 29 / 29 通过 |
| Agent 单元测试 | 8 / 8 通过 |
| Server HTTP / WS / 开发入口 | 21 / 21 通过（其中实际 watcher 测试 1 项） |
| 网页单元与客户端状态测试 | 37 / 37 通过，4 个测试文件 |
| 真实 Chromium 组件测试 | 18 / 18 通过 |
| 真实 Node / Vite 入口 E2E | 2 / 2 通过 |
| 总计 | **115 项，0 失败**；根 npm test 退出码 0 |
| 依赖审计 | 0 漏洞 |
| diff 空白检查 | 通过 |

Model 本阶段只有类型，做构建检查，不添加没有行为的运行测试。新增 `.test.ts` 已纳入 Vitest，不会只运行原 `.test.tsx`。E2E 独立命令先执行完整构建，避免旧 web/dist 造成假通过。

最终完整命令输出位于 `web/test-results/verification.log`。这是本机忽略产物，不提交。Playwright 数量及结果在 `web/test-results/components.json`、`web/test-results/e2e.json`；它们会在下次测试时更新。

## 对照五组阶段验收

### 1. 签名密钥安全初始化：通过

`packages/credentials/test/credentials.test.ts` 使用临时目录，包含 16 个同进程调用与 6 个真实 Node 子进程并发；全部取得同一 32 字节密钥。检查目录 0700、文件 0600，已有文件内容和 mtime 不变，规范 base64url / 版本、坏 JSON、宽权限、不可读目录/文件、符号链接与非普通文件拒绝；锁、临时文件、rename 和 close 失败均有保护与脱敏检查。所有测试不读写默认用户签名文件。

### 2. 授权交换、有效期与握手：通过

`packages/server/test/webserver.test.ts` 经真实临时 HTTP / WS 监听验证：有效令牌 303、Location `./`、HttpOnly / SameSite=Strict / Path=/、固定 30 天、不续期；Cookie 与端口绑定，篡改、未来签发、过期均拒绝；同密钥同端口重启有效，启动令牌变化，更换密钥并重启后旧 Cookie 失效。已有 WS 到期后仍可订阅，未添加到期强制关闭计时器。

HTTP、静态资源与 WS 握手都需要授权；不可信 Host、Origin、null Origin 和显式跨站拒绝，缺 Origin 也不免 Cookie。检查 no-store、no-referrer、防静态路径穿越，以及不信任 X-Forwarded-*。本服务实际只监听本机 HTTP，Cookie 不设置 Secure；Cookie 生成器支持真实 TLS 时的 Secure 标记，但本阶段未部署 HTTPS 监听。

### 3. Agent 初始状态与订阅清理：通过

真实 Agent 首项精确为：

```json
{"seq":0,"messages":[],"running":null,"activeContent":[]}
```

8 项 Agent 测试覆盖独立副本、多订阅、预取消、等待中取消、并行 next 和提前 return。Agent 不接收 Cookie、WS 或网络编号，也没有模型调用或消息提交入口。

Server 用受控源验证先快照后更新、网络编号封装、替换 / 取消、旧订阅异常隔离、非法帧、发送失败、缓冲超限只影响所属页面。每 2 秒心跳、两次未响应检查后失活清理；端口冲突、签名初始化失败、关闭中的不回应 WS 与未完成 HTTP 请求不会遗留监听。

### 4. 页面恢复、就绪边界与草稿：通过

`chat/state.test.ts`、`chat/client.test.ts` 与页面测试验证：握手仅进入 awaitingSnapshot，只有当前编号有效快照进入 ready；旧编号和重复序号忽略，跳号重新订阅，新快照可在后端重启后重建 seq 基线。假时钟覆盖 3 秒慢提示、15 秒准备截止、500ms × 2 / 10s 上限及 50%–100% 抖动、离线暂停、上线恢复和计时清理。

ChatPage 始终禁发送且 onSend 返回 false；MessageInput 的外部门禁只阻止发送。18 项真实 Chromium 测试保留原文、真实粘贴、撤销、字体、窄屏和低高度、阅读位置等回归，新增禁发送 / 门禁切换时的编辑器同一性、草稿、焦点与撤销断言。受控长历史用于页面测试，不冒充生产 Agent 已有消息。

### 5. 两种实际入口的闭环：通过

`web/tests/e2e/chat.spec.ts` 启动真实 Node 子进程、真实构建网页与真实 Vite 5173 代理，不拦截或伪造业务快照。两种模式都观察浏览器真实 WS 帧并校验空快照；验证授权前 HTTP / WS 拒绝、303 后干净 URL、Cookie 属性、二页面观察同一空状态、刷新清空草稿、离线上线、监听断开恢复、进程 SIGKILL 后同端口重启与旧 Cookie 继续有效。重启期间草稿和焦点保留，未发起 `/api/messages` 请求。

Vite 使用 strictPort、127.0.0.1:5173，/auth 重写到后端根，/api 代理 HTTP / WS，保留 Host、Origin、Cookie。真实经过代理的恶意 Host / Origin / null Origin / cross-site 请求均 403，无 Cookie 401；Cookie authority 为 Vite 5173，未被改成后端端口。

开发 watcher 另在临时项目副本中运行真实 main 和 Node watch；修改 Credentials、Model、Agent、Server 各自源码均触发服务重启，SIGTERM 后端口可重新绑定。测试只修改临时副本，避免覆盖开发者工作区内容。测试结束后子进程、临时签名文件和临时监听清理，5173 / 3100 不留测试服务。

## 审查及实现取舍

- 两轮独立只读审查发现并修复旧订阅延迟异常误关新订阅、CLOSING WS 拖延退出；均先用回归复现失败再修复。
- 另修复 E2E 构建前置与测试请求头类型检查问题。最终审查没有未解决的 P1 / P2 / P3。
- Pi 的模型类型归模型包、Agent 独占状态与传输独立的边界保持一致。Pi 的原始订阅本身不提供独立快照，本项目按既定文档增加这一恢复契约；每个网页取消观察者不取消共享任务。
- 文件保护沿用 dsh 思想，但最小版本不自动接管崩溃遗留锁：等待 2 秒后安全报错，不猜测删除其他进程的锁。停止所有相关服务并确认锁中 PID 已退出后，人工移走残留 `browser-auth.json.lock` 再启动。详见 Credentials README。
- `AGENT_LEARNING_BROWSER_AUTH_FILE` 只为自动校验提供隔离路径；正常运行不设置它，仍用固定 `~/.agent-learning/browser-auth.json`。
- 原子替换不承诺断电持久性；阶段一不提前实现模型函数、模型设置、提交、工具执行或聊天持久化。

## 本机截图

以下是实际 E2E 在后端重启恢复后的干净页面，显示连接就绪、保留的草稿和禁用发送：

- [Node 入口](../../../web/test-results/e2e/chat-node-实际授权、空快照与恢复/node-ready.png)
- [Vite 入口](../../../web/test-results/e2e/chat-vite-实际授权、空快照与恢复/vite-ready.png)

截图和测试日志不包含签名密钥或 Cookie；E2E 关闭 trace，避免把启动令牌导航存入 trace。首次 E2E 写入时装配已到位，因此不声称 E2E 观察过业务 RED。

## 未实测与阶段边界

- 未实测系统中文输入法与实际 Safari。现有合成组合输入事件、Chromium 原生输入与撤销通过，不替代这两项人工检查。
- 未验证 Windows 权限或断电恢复；当前交付环境为 macOS。
- 没有请求真实模型；空快照、受控更新和重连不能证明阶段三生成期间的恢复正确。
