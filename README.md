# SI

English · [简体中文](README.zh.md)

SI is a coding agent that runs on your machine and works through a browser. Choose a project folder and describe what you want done. SI uses DeepSeek to find and edit files and run commands as needed. The browser shows replies, tool calls, and results as they come in.

SI is written in TypeScript as a project for learning how to build a coding agent. Its backend architecture draws on [Pi](https://github.com/earendil-works/pi), and its web interface and interactions draw on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Getting started

You’ll need macOS, Node.js, and a DeepSeek API key. Node.js 24.16.0 is recommended. Adding a workspace opens the macOS folder picker. The web interface currently uses Simplified Chinese.

```sh
git clone https://github.com/chensirui666/si.git
cd si
npm ci
npm run build
npm --prefix packages/server start
```

1. Open the full authorization link printed in your terminal. The server runs at `127.0.0.1:3000` by default.
2. In the sidebar, go to **Settings (设置) → Models (模型) → Add provider (添加提供方) → DeepSeek** and save your API key.
3. Select **New session (新会话)**, add or choose a workspace above the message box, and send a task. Try “Read this project’s README and tell me how to run it.”

## What you can do

- **Run a task that takes several steps.** SI can search the code, read relevant files, then edit the code or run a command. Expand the execution details to see each step, or stop the task while it’s running.
- **Organize sessions by project.** Tasks keep running as you switch sessions. After restarting the server, you can review saved conversations and tool results, then send a message to continue.
- **Give SI project instructions.** SI reads files such as `AGENTS.md` to learn your project’s conventions.
- **Keep long conversations going.** SI compacts older messages as a conversation approaches the model’s context limit. Send `/compact` to do this manually. You can still review the original conversation.
- **Search and read web pages.** Add a Tavily API key in **Settings (设置) → Web tools (网页工具)**.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| [`packages/model/`](packages/model/) | Calls the model and streams its response |
| [`packages/agent/`](packages/agent/) | Runs tools requested by the model and feeds back their results until the task ends |
| [`packages/coding-agent/`](packages/coding-agent/) | Manages sessions, project instructions, context compaction, and tool implementations |
| [`packages/credentials/`](packages/credentials/) | Manages local credentials |
| [`packages/server/`](packages/server/) | Handles browser requests and syncs session and task state |
| [`web/`](web/) | Provides the chat interface, drafts, and settings |

## Permissions and data

Tools use the workspace as the starting point for relative paths. File tools and Bash run with the permissions of the user who starts SI and can access files outside the workspace. File changes already written to disk persist when you stop a task.

Sessions, workspace settings, and API keys are stored in `~/.agent-learning/` by default. Model requests send the relevant conversation, project instructions, and tool results to DeepSeek. Web tools send search queries and page URLs to Tavily. Keep the startup authorization link private, since it grants access to the local server.

## Development

From the repository root, run `npm run dev:server` and `npm --prefix web run dev` in separate terminals. Open the development link printed by the backend.

```sh
npx playwright install chromium
npm test
```

See the [development guide](docs/development.md), [project documentation](docs/README.md), and [roadmap](planning/README.md) for more detail. These documents are in Chinese.

## License

[MIT](LICENSE)
