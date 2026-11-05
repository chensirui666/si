# Agent 交流与讲解约定

Agent 在本项目中的回复必须遵守以下要求：

- 从第一性原理出发，先讲最基本的事实和要解决的问题。
- 按三岁小孩也能听懂的标准解释，不预设用户懂编程或 Agent 术语。
- 依次讲清：是什么、为什么需要、怎样工作、与前后环节有什么关系。
- 新概念用日常词语和具体例子说明，不用一个陌生术语解释另一个陌生术语。
- 必要时用生活类比帮助理解，再对应回真实代码。
- 讲得简单但准确，抓住整体和主流程，支线细节简要带过。

## 运行项目

已接入本机授权、模型设置和真实 DeepSeek 流式聊天。配置模型后可发送消息，实时查看正文与折叠的思考过程；生成期间仍可编辑下一条草稿。刷新或重连恢复后端进度。消息只在后端进程内存中，重启后清空。

```sh
npm ci
npm run build
npm --prefix packages/server start
```

打开终端打印的完整授权链接，浏览器取得 Cookie 后自动跳转到干净地址。默认监听 `127.0.0.1:3000`；首次启动会安全创建 `~/.agent-learning/browser-auth.json`。不要分享授权链接。签名文件损坏或权限错误时服务拒绝启动，不会自动覆盖它。

从侧栏底部“设置 → 模型 → 添加提供方 → DeepSeek”保存 API Key，可替换或删除。Key 仅写入本机 `~/.agent-learning/auth.json`，页面只接收配置状态；多个页面会同步模型列表，重启后配置仍在。保存成功只表示本地配置可用，不表示远端认证通过。模型文件损坏仍可进入设置，但需要先人工修复文件，页面不会覆盖坏文件。

发送后立即清空本次草稿；后端先回执，再推送生成进度。生成、提交未确认或连接恢复期间暂停发送，不影响编辑。明确拒绝和未确认接收分别标记，不自动重发或恢复已清空草稿。失败回复保留展示，但下一轮模型历史排除这条失败回复。当前仅聊天与工具请求展示，不执行工具。

开发时分别运行：

```sh
npm run dev:server
npm --prefix web run dev
```

前者首次构建全部后端包，并监听 Credentials、Model、Agent、Server 的源码变化和重启；后者固定使用 `127.0.0.1:5173`。打开后端打印的“开发入口”链接（`/auth?token=…`），由 Vite 同源代理交换授权并连接。`AGENT_LEARNING_SERVER_PORT` 可为后端和 Vite 指定一致的其他端口，Vite 页面端口仍固定 5173。

## 校验

```sh
npx playwright install chromium
npm test
```

根 `npm test` 先构建后端并跑 Credentials、Model、Agent、Server 测试，再运行网页单元测试、真实 Chromium 组件测试、两种实际入口 E2E。E2E 前会执行完整构建；测试只使用临时签名与模型文件，不访问真实用户配置。

真实服务商验收需显式提供已有 dotenv 文件位置，文件包含 `DEEPSEEK` 或 `DEEPSEEK_API_KEY`。Key 只读入内存，再经真实设置页面保存到测试临时目录；不改原文件、不输出 Key、不保存包含凭据的浏览器 trace。未提供时该项明确跳过，不能据此声称通过真实模型验收。

```sh
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env npm test
```

独立命令、系统输入法检查和说明见 [web/README.md](web/README.md)。本阶段实际证据见 [Feature2 验收记录](planning/里程碑1/feature2/feature2-验收记录.md)。

Feature3 在后端提供 `read`、`bash`、`edit`、`write` 四种工具声明，调用方通过 `ModelContext.tools` 显式传给模型。仅接收待校验的调用，不执行工具；普通网页聊天继续不携带工具声明。截断、失败或取消的调用不会交付给后续处理。

四工具真实模型验收独立运行，使用现有 Credentials 只读本机 `~/.agent-learning/auth.json`，不改凭据文件、不执行工具、不自动重试；无配置时明确跳过，失败时如实报错：

```sh
npm run build:packages
npm --prefix packages/server run test:tools:live
```

实际结果见 [Feature3 验收记录](planning/里程碑1/feature3/feature3-验收记录.md)。
