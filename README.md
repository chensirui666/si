# Agent 交流与讲解约定

Agent 在本项目中的回复必须遵守以下要求：

- 从第一性原理出发，先讲最基本的事实和要解决的问题。
- 按三岁小孩也能听懂的标准解释，不预设用户懂编程或 Agent 术语。
- 依次讲清：是什么、为什么需要、怎样工作、与前后环节有什么关系。
- 新概念用日常词语和具体例子说明，不用一个陌生术语解释另一个陌生术语。
- 必要时用生活类比帮助理解，再对应回真实代码。
- 讲得简单但准确，抓住整体和主流程，支线细节简要带过。

## 运行项目

已接入本机授权、工作区选择、DeepSeek 流式聊天和八种工具。先配置模型，然后在侧栏点击「添加工作区」，从 macOS 系统面板选一个文件夹，再进入该文件夹下的「当前对话」。输入区显示绑定目录。刷新或重连恢复对话和任务进度。服务重启后保留工作区登记和绑定，当前对话从空历史开始。

```sh
npm ci
npm run build
npm --prefix packages/server start
```

打开终端打印的完整授权链接，浏览器取得 Cookie 后自动跳转到干净地址。默认监听 `127.0.0.1:3000`；首次启动会安全创建 `~/.agent-learning/browser-auth.json`。不要分享授权链接。签名文件损坏或权限错误时服务拒绝启动，不会自动覆盖它。

从侧栏底部“设置 → 模型 → 添加提供方 → DeepSeek”保存 API Key，可替换或删除。Key 仅写入本机 `~/.agent-learning/auth.json`，页面只接收配置状态；多个页面会同步模型列表，重启后配置仍在。保存成功只表示本地配置可用，不表示远端认证通过。模型文件损坏仍可进入设置，但需要先人工修复文件，页面不会覆盖坏文件。

发送后立即清空本次草稿。提交被明确拒绝时，如果你还没有开始写下一条，输入区会恢复原稿。提交未确认时会标明状态。生成或连接恢复期间可编辑草稿，等任务结束或连接恢复后再发送。

发送后主按钮切换为「中止」，收到后台运行状态后启用。点击后等待本次模型或工具收尾，保留已有内容和结果，确认空闲后可继续发送。中止期间仍可编辑草稿，保留撤销记录。停止不会撤销已经发生的文件修改；刷新、关闭页面或断线不自动停止任务。具体校验见 [Feature5 验收记录](planning/里程碑1/feature5/feature5-验收记录.md)。

Agent 等模型给完一批工具调用，再依次执行，随后请模型根据结果回答。运行时「执行过程」显示思考与工具状态，结束后自动收起，仍可展开查看参数和真实结果。一次提交可以带多条工具调用。先读文件、再依据读到的内容做修改，需要分两次提交。

本地工具有 `read`、`bash`、`edit`、`write`、`find` 和 `grep`。工作区是相对路径的起点，工具拥有本机服务进程的文件和命令权限。网页工具 `web_search` 与 `web_fetch` 通过「设置 → 网页工具」配置，默认共用 Tavily Key。使用网页工具前，在该设置页保存 Tavily Key。服务商选择写入 `~/.agent-learning/settings.json`，Key 写入同目录下的 `auth.json`。

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

独立命令、系统输入法检查和说明见 [web/README.md](web/README.md)。Feature2 的实际证据见 [Feature2 验收记录](planning/里程碑1/feature2/feature2-验收记录.md)。

八种工具都从正式服务入口验收。根测试在 Chromium 中发起真实 `read`，其余七种通过下面的命令调用实际 HTTP 和 WebSocket 接口。每项核对工具执行、结果回填及最终回答。指定包含 `DEEPSEEK` 或 `DEEPSEEK_API_KEY` 的 dotenv 文件，以及包含 `TAVILY_API_KEY`（也接受 `TAVILY` 或 `tavily`）的测试文件，两者可以使用同一个文件。凭据和工作区使用测试临时目录。

```sh
npm run build:packages
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env \
TAVILY_LIVE_KEY_FILE=/absolute/path/to/test.env \
npm --prefix packages/server run test:tools:live
```

实际结果见 [Feature4 验收记录](planning/里程碑1/feature4/feature4-验收记录.md)。
