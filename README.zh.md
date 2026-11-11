# SI

[English](README.md) · 简体中文

SI 是一个在本机运行、通过浏览器使用的编程 Agent。选一个项目文件夹，告诉 SI 你想做什么。它会调用 DeepSeek，按任务需要查找和修改文件、运行命令，并在网页里实时展示回答、工具调用和结果。

SI 用 TypeScript 构建，用于学习和实践编程 Agent 的实现。后端架构主要参考 [Pi](https://github.com/earendil-works/pi)，网页界面与交互参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 快速开始

准备 macOS、Node.js 和一个 DeepSeek API Key。推荐使用 Node.js 24.16.0。添加工作区时，SI 会打开 macOS 的系统文件夹选择器。

```sh
git clone https://github.com/chensirui666/si.git
cd si
npm ci
npm run build
npm --prefix packages/server start
```

1. 打开终端打印的完整授权链接。服务默认运行在 `127.0.0.1:3000`。
2. 在网页侧栏打开 **设置 → 模型 → 添加提供方 → DeepSeek**，保存 API Key。
3. 点 **新会话**，在输入框上方添加或选择工作区，然后发送任务。可以先试一句「读一下这个项目的 README，告诉我怎么运行它。」

## 你可以用 SI 做什么

- **在一个任务里完成多步操作。** SI 可以先搜索代码，再读取相关文件，最后修改代码或运行命令。你可以展开「执行过程」查看每一步，也可以中止任务。
- **按项目管理会话。** 切换会话时，已经启动的任务会继续运行。重启服务后，可以回看已保存的对话和工具结果，再发一条消息继续。
- **给 Agent 提供项目约定。** SI 会读取 `AGENTS.md` 等项目说明。
- **继续长对话。** 对话接近模型容量时会自动压缩，也可以发送 `/compact` 手动压缩。原始对话仍可回看。
- **搜索和读取网页。** 在 **设置 → 网页工具** 中配置 Tavily API Key 后，可以让 SI 搜索资料或读取网页内容。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| [`packages/model/`](packages/model/) | 调用模型并接收流式回复 |
| [`packages/agent/`](packages/agent/) | 执行模型请求的工具，把结果交回模型，直到任务结束 |
| [`packages/coding-agent/`](packages/coding-agent/) | 管理会话、项目说明、上下文压缩和工具实现 |
| [`packages/credentials/`](packages/credentials/) | 管理本机凭据 |
| [`packages/server/`](packages/server/) | 接收网页请求，把会话和运行状态同步给网页 |
| [`web/`](web/) | 提供聊天界面、草稿和设置 |

## 权限与数据

工作区是工具处理相对路径的起点。文件工具和 Bash 以启动 SI 的用户权限运行，可以访问工作区之外的文件。中止后，已经写入的文件改动会保留。

会话、工作区设置和 API Key 默认保存在 `~/.agent-learning/`。模型请求会把所需的对话、项目说明和工具结果发送给 DeepSeek。使用网页工具时，搜索词和要读取的网址会发送给 Tavily。启动链接可以授予浏览器访问本机服务的权限，请勿分享。

## 开发

在仓库根目录打开两个终端，分别运行 `npm run dev:server` 和 `npm --prefix web run dev`，然后打开后端打印的开发入口链接。

```sh
npx playwright install chromium
npm test
```

更多细节见[开发指南](docs/development.md)、[项目文档](docs/README.md)和[项目规划](planning/README.md)。

## 许可证

[MIT](LICENSE)
