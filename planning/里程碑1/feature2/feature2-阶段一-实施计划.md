# Feature2 阶段一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 完成授权打开、真实空快照订阅、重连与清理；允许草稿编辑，始终禁止聊天发送。

**Architecture:** Model 只导出消息类型，Agent 独占对话状态并提供进程内订阅，Server 处理授权、页面与网络订阅，Credentials 保护签名文件。网页只通过公开类型入口依赖后端包。沿用现有 React、Lexical 和视觉。

**Tech Stack:** Node.js 24、TypeScript 5.9.3、npm workspace、node:http、ws、React、Vite、Vitest、Playwright。

**Spec:** [阶段一文档](./feature2-阶段一-打开授权与订阅.md)，共享契约见[总体设计](./feature2-单会话流式聊天技术设计.md)。

## Global Constraints

- worktree 位于当前项目 `.worktrees/feature2-stage1`，分支 `codex/feature2-stage1`；不改主 checkout 的源码。
- 根 workspace 管理 web 与 packages/*；根锁文件取代 web/package-lock.json，沿用网页现有依赖版本。
- 固定网页签名文件 `~/.agent-learning/browser-auth.json`；测试用临时路径，绝不读写用户真实密钥。
- 创建目录 0700、文件 0600；锁内重读、同目录独占临时文件、原子替换；坏文件拒绝并保留。
- Cookie HMAC-SHA256、30 天、地址及端口绑定、HttpOnly、SameSite=Strict、Path=/；不为已有 WS 添加到期断开。
- Vite 固定 127.0.0.1:5173、strictPort；代理保留 Host、Origin、Cookie，不开启泛化 CORS。
- 3 秒提示慢、15 秒未就绪重试；重连 500ms × 2，上限 10s，50%–100% 抖动；离线暂停。
- 服务端每 2 秒 Ping、两次未响应检查后清理；订阅取消不改变共享 Agent。
- 不实现模型发现、模型调用、消息提交或磁盘聊天记录。

## Review Focus

- 多进程首次启动竞争：所有进程必须读到同一密钥；失败不得覆盖已有文件。
- 伪造 Host、跨站和 null Origin、过期/篡改 Cookie：页面、静态资源与握手统一拒绝。
- Vite 代理后的真实地址：Cookie 按 5173 签发，不能改写来源绕过检查。
- 旧连接/订阅晚到的事件：不能让新订阅提前 ready，跳号重新订阅、旧序号不重复应用。
- StrictMode、离线、超时、退出和失败发送：清理计时器/监听/所属订阅，草稿、焦点与阅读位置保留。

---

### Task 1: 安全签名文件与工作区

**Files:** 根 package.json/package-lock.json/tsconfig.base.json，packages/credentials/{package.json,tsconfig.json,README.md,src/{index,types,credentials,credential-file}.ts,test/credentials.test.ts}；迁移 web 配置和锁。

**Interfaces:** `loadOrCreateBrowserSecret(): Promise<Buffer>` 为正式公开 API；允许可控的内部文件路径用于临时目录测试。

- [x] 写文件系统集成测试：有效 32 字节密钥与权限、并发/子进程一致、已有文件不变、坏 JSON/版本/base64url、宽权限、读写失败、错误脱敏及临时文件清理。
- [x] 执行测试并确认功能缺失的失败，再实现最小文件保护与公开入口。
- [x] `npm --prefix packages/credentials test` 和类型检查通过；锁迁移后 `npm ci` 可重建工作区。

### Task 2: Model 契约与 Agent 初始订阅

**Files:** packages/model/{package.json,tsconfig.json,README.md,src/{types,index}.ts}；packages/agent/{package.json,tsconfig.json,README.md,src/{types,agent,index}.ts,test/agent.test.ts}。

**Interfaces:** Model 与 Agent 类型逐项沿用阶段文档；`Agent.subscribe(signal: AbortSignal): AsyncIterable<{type:'snapshot';snapshot:ConversationSnapshot}|{type:'update';update:ConversationUpdate}>`。

- [x] 写测试：快照为 `{seq:0,messages:[],running:null,activeContent:[]}`；副本独立、多订阅、取消一个不影响其他、已取消信号、迭代器 return 释放资源。
- [x] 确认失败后实现；Agent 不引入网络编号、Cookie 或浏览器依赖，不增加阶段三运行入口。
- [x] `npm --prefix packages/model run build`、`npm --prefix packages/agent test` 通过。

### Task 3: HTTP 页面、授权与 WS

**Files:** packages/server/{package.json,tsconfig.json,README.md,src/main.ts,src/webserver/{index,browser-auth,protocol}.ts,test/webserver.test.ts}；根后端构建/监听入口。

**Interfaces:** `WebServer.start()` 返回监听地址与授权链接，`close()` 释放监听、WS、心跳、内部订阅；Server 公开 protocol 类型子入口，核心包只通过公开入口使用。

- [x] 写集成测试：303 与干净 URL、Cookie 属性/30天/端口绑定/不续期、伪造/过期、持久密钥重启与换密钥、Host/Origin/Sec-Fetch-Site 拒绝、无 Origin 仍须授权、静态资源路径保护。
- [x] 写 WS 测试：握手不等于订阅、真实空快照、受控源快照后更新、替换与 unsubscribe、非法帧隔离、发送失败、心跳及关闭、启动失败清理、已有 WS 不因 Cookie 到期关闭。
- [x] 确认失败后实现原生 HTTP/ws 与最小授权类；生产页面从仓库根 web/dist 定位，Server 构建不读取页面产物。
- [x] `npm --prefix packages/server test` 通过；dev:server 首次构建并监听所有后端包，依赖变更亦触发重启。

### Task 4: 前端恢复与草稿保护

**Files:** web/src/chat/{client,state}.ts 及测试，ChatPage、MessageInput、types、styles，已有组件/浏览器测试和测试 harness；web/vitest.config.ts、vite.config.ts。

**Interfaces:** `ConnectionState` 四个状态沿用文档；`MessageInputProps` 为 `onSend:(text:string)=>boolean; sendDisabled:boolean`；客户端订阅返回清理函数并向页面提供当前订阅状态。

- [x] 写状态/假时钟测试：握手仍 awaitingSnapshot、当前有效快照才 ready、旧编号隔离、重复序号忽略、跳号重订阅、3s/15s、指数退避/抖动/上限、离线暂停/恢复、取消与旧回调隔离。
- [x] 确认失败后实现连接/订阅客户端，MessageInput 禁发送不禁编辑，更新所有调用方并保留输入法、原文与撤销断言。
- [x] 真实 Chromium 验证连接切换期间草稿、焦点、阅读位置、窄屏与低高度布局；受控数据只作为 UI 测试证据。
- [x] `npm --prefix web run test:unit` 与 `npm --prefix web run test:browser` 通过，确保 *.test.ts 被纳入。

### Task 5: 两种实际入口与全部验收

**Files:** web/playwright.config.ts、web/tests/e2e/chat.spec.ts 及最小测试装配，README.md、各包 README、web/README.md、feature2-验收记录.md。

- [x] 两条真实 E2E：Node 构建入口、Vite 5173 /auth 代理入口；真实 Cookie/WS/Agent 空快照、刷新、断线、离线、后端同端口重启、二页面共用状态、始终禁止提交。
- [x] 真实代理验证 Host/Origin 不被改写；所有后端测试用临时签名路径，不运行模型、不请求模型网络接口。
- [x] 根 `npm run build`、`npm run test:packages`、web 单元/浏览器/E2E 全通过；检查根锁可安装、跨包公开入口、生产包不读私有实现、dev 依赖监听。
- [x] 独立审查变更与测试覆盖，修复发现的问题，再记录实际命令、数量、结果、未覆盖项与证据路径。
- [x] 初次交付保留 worktree 供审阅；2026-11-03 按用户后续指令提交并合并 `main`，完成主目录复验后删除实施 worktree 和已合并功能分支，未推送远端。

## 与 Pi 的关系及风险

Pi 将模型契约放在 pi-ai，Agent 状态归 Agent，传输由上层负责；本项目沿用此边界。Pi 的 `subscribe(listener)` 本身没有独立快照与连续序号，因此这里的 `subscribe(signal)` 是为网页重连增加的已设计能力，不能直接把 Pi 的可变 state 引用发给网络。

网页授权与文件保护沿用本地 dsh 参考的工程思想，按阶段文档收敛，不复制完整 RPC、插件或权限体系。原子替换不承诺断电持久性；实际 Safari 与系统中文输入法需另记实测范围，不能用合成事件替代。
