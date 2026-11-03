# Feature2 验收记录

日期：2026-11-03。范围：**阶段一：打开、授权与订阅；阶段二：凭据配置与本地模型发现**。前半保留阶段一合并验收记录，本轮交付见文末“阶段二验收”。阶段三真实聊天与生成中恢复尚未实现或验收。

阶段一已完成实现与本阶段自动验收，提交 `31e5d31` 已合并本地主干 `main`，未推送远端。主目录重新安装依赖后，115 项测试再次全部通过；实施 worktree 和已合并功能分支已删除。当前交付：安全授权打开本地页面，建立 WebSocket，订阅唯一 Agent 的真实初始空快照，刷新、断线、离线和服务重启后恢复连接；草稿仍可编辑，聊天发送始终关闭。

## 交付位置与环境

- 当前交付目录：`/Users/stardust/agent learning`（`main`）。原实施 worktree 为项目内 `.worktrees/feature2-stage1`，已在合并复验后删除。
- 实施分支：`codex/feature2-stage1`；起点 `973618e`（main），实现提交 `31e5d31`。分支已安全合入 `main` 后删除。
- 实施期间主 checkout 保持干净，集成时按用户指令快进合并。仓库本地 `.git/info/exclude` 中保留 `/.worktrees/`，避免递归跟踪。
- Node.js `v24.16.0`，npm `11.13.0`，TypeScript `5.9.3`，Playwright `1.62.1` / Chromium。
- 根 npm workspace 管理四个后端包及 web，根 package-lock.json 取代 web 独立锁。逐项比较旧锁已有依赖，版本变化为 0；新增运行依赖 ws 固定为 `8.22.1`。

实施依据：[阶段一设计](./feature2-阶段一-打开授权与订阅.md)、[实施计划](./feature2-阶段一-实施计划.md)、[总体契约](./feature2-单会话流式聊天技术设计.md)。实施方案、关键边界与风险已在实施前获用户确认。

## 最终命令与结果

在实施 worktree 根执行，并在合并后的主目录重新执行：

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

合并后主目录完整命令输出位于 `web/test-results/verification.log`；合并前日志与截图另存 `web/test-results/feature2-stage1-premerge/`。这是本机忽略产物，不提交。Playwright 数量及结果在 `web/test-results/components.json`、`web/test-results/e2e.json`；它们会在下次测试时更新。

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

## 阶段二验收

2026-11-03，在 worktree `/Users/stardust/.codex/worktrees/feature2-stage2/agent learning`、分支 `codex/feature2-stage2` 完成实现；起点为主目录 HEAD `e14df7a`。实现已提交为 `6079546`，并按使用者指令快进合并到 `/Users/stardust/agent learning` 的 `main`。提交前及主目录合并后两次完整校验均为 161 项通过。

worktree 清理待完成：Codex 的归档工具返回 `The task's primary checkout cannot be removed.`，因为此聊天当前仍以该 worktree 为主工作目录。尝试切回主目录时，附加工具确认主目录不是受管理 worktree；自动操作 Codex 自身界面也被工具禁止。因此保留这个干净 worktree 和已合并分支，待使用者将此聊天切回主目录后再清理。没有强行删除目录或修改应用内部状态。

依据：[阶段二设计](./feature2-阶段二-凭据配置与本地模型发现.md)与[实施计划](./feature2-阶段二-实施计划.md)。实施前使用者明确选择“按文档方案继续”。

### 交付行为

- 授权后从侧栏底部“设置 → 模型 → 添加提供方 → DeepSeek”保存 Key，已配置时可替换、删除；模型栏随当前文件显示 DeepSeek Flash、无可用模型或配置错误。
- Key 只存本机 JSON，文件 0600、目录 0700；网页不回填 Key，不写浏览器存储或聊天历史。保存成功只表示本地配置通过，不声称远端有效。
- 锁内重读并保留其他顶层条目，同目录随机临时文件与原子替换；坏文件、宽权限或写入失败均报错，保留原文件，不回退旧 Key。
- 配置增改删与外部文件新增、替换、删除、损坏、修复及文件/父目录权限变化均通知页面；重连重新查询，不改变 Agent 对话序号。草稿继续可编辑，聊天发送仍关闭。

### 最终校验结果

使用 Node.js v24.16.0、npm 11.13.0。新依赖仅 chokidar 5.0.0 与 Radix Dialog 1.3.1 及其传递依赖，全部锁在根 package-lock.json。

合并后在主目录重新执行 `npm ci`、根 `npm test`、`npm audit --json` 与 `git diff --check`，均通过。下表为主目录复验结果。

| 检查 | 实际结果 |
| --- | --- |
| 干净安装与构建 | npm ci、四后端包 TypeScript、网页 TypeScript 与生产构建均成功 |
| Credentials 文件系统集成 | 53 / 53 通过，含既有签名文件保护及模型文件增改删、坏文件、权限、失败保护、并发与监听 |
| Model 本地发现 | 2 / 2 通过，配置、替换、删除、错误及零远端请求 |
| Agent 既有回归 | 8 / 8 通过 |
| Server HTTP / WS / 开发入口 | 25 / 25 通过，含配置授权、非法 JSON/类型/额外字段、64KiB 边界、脱敏、通知与重启 |
| 网页单元测试 | 50 / 50 通过，含配置操作、Key 清空、查询错误、旧响应隔离与保存失败恢复 |
| 真实 Chromium 组件 | 19 / 19 通过，含 Dialog 焦点约束、Escape、焦点返回及既有输入/阅读位置/窄屏回归 |
| Node / Vite 实际入口 E2E | 4 / 4 通过，两项既有授权恢复及两项阶段二配置闭环 |
| 合计 | 161 / 161 通过，无跳过用例 |
| 依赖审计与差异 | npm audit 0 漏洞；git diff --check 通过 |

主目录复验日志：[完整测试](../../../web/test-results/verification-stage2.log)、[干净安装](../../../web/test-results/install-stage2.log)、[依赖审计](../../../web/test-results/audit-stage2.json)。产物均在本机忽略目录；组件和 E2E 详细结果为 `web/test-results/components.json`、`e2e.json`，会被下次执行更新。合并前的测试、审计、结果 JSON 与截图已另存主目录 `web/test-results/feature2-stage2-premerge/`，包括[提交前全量测试](../../../web/test-results/feature2-stage2-premerge/precommit-stage2.log)，不依赖待清理 worktree。

实际 E2E 使用真实 WebServer、独立后端进程、临时签名与模型文件、浏览器 Cookie、HTTP、WebSocket 和 Vite 代理；业务接口没有拦截或假返回。两种入口都验证保存、替换、关闭清空、另一页面同步、SIGKILL 后同端口重启读回、删除、外部坏文件仍可打开设置且不能覆盖、修复恢复；对话始终空快照、没有提交聊天。测试不读写真实用户配置。

### 审查与修复

- 独立只读审查发现“初始 GET 尚未返回时保存失败会永久显示查询中”。先用回归观察失败，再删除保存开始时多余的失效回调；成功保存仍隔离旧响应并重新查询。定向复审通过，当前无未解决 P1/P2。
- 基线 Chromium 清空输入用例复现了 Playwright 直接 DOM 全选后立刻删除与 Lexical 选区同步的竞争。改为真实全选与 Backspace，保留原清空、高度与阅读位置断言，定向重复五次通过；生产编辑器未修改。
- chokidar 对不存在路径的首次创建、以及读取后 chmod 的漏通知均经真实文件测试复现并修复。监听最近已有祖先，按目标路径过滤，并补查文件与直接父目录权限。
- 配置通知可能先于对话帧到达；阶段一对话测试按协议分别筛选配置通知与对话帧，继续核验原快照、序号和清理行为。
- Pi 的提供方 JSON、锁内重读与模型可用性分离保持一致。按既定设计拒绝 Pi/dsh 的读取失败后保留旧缓存策略，继续复用本项目更严格的文件保护。
- `AGENT_LEARNING_MODEL_AUTH_FILE` 与既有签名路径覆盖一样，仅供实际开发入口测试隔离文件位置；Key 仍只有 JSON 一个来源。正常运行不设置这些覆盖。

### 视觉证据与边界

已查看实际桌面与 390px 窄屏截图，弹窗与操作完整可见，无水平溢出：

- [Node 设置](../../../web/test-results/e2e/chat-node-阶段二配置、重启与多页面/node-settings.png)、[窄屏设置](../../../web/test-results/e2e/chat-node-阶段二配置、重启与多页面/node-settings-narrow.png)、[配置闭环后页面](../../../web/test-results/e2e/chat-node-阶段二配置、重启与多页面/node-stage2-ready.png)。
- [Vite 设置](../../../web/test-results/e2e/chat-vite-阶段二配置、重启与多页面/vite-settings.png)、[窄屏设置](../../../web/test-results/e2e/chat-vite-阶段二配置、重启与多页面/vite-settings-narrow.png)。

本轮未请求真实 DeepSeek，未验证远端 Key 或实际聊天生成；这些属于阶段三。未实测 Safari、系统中文输入法、Windows 权限及突然断电恢复。沿用异常退出后残留锁需人工恢复的限制。生产 JS 包约 522kB，Vite 给出超过 500kB 的体积提示，构建成功；本阶段未额外引入拆包方案。
