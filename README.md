# Agent 交流与讲解约定

Agent 在本项目中的回复必须遵守以下要求：

- 从第一性原理出发，先讲最基本的事实和要解决的问题。
- 按三岁小孩也能听懂的标准解释，不预设用户懂编程或 Agent 术语。
- 依次讲清：是什么、为什么需要、怎样工作、与前后环节有什么关系。
- 新概念用日常词语和具体例子说明，不用一个陌生术语解释另一个陌生术语。
- 必要时用生活类比帮助理解，再对应回真实代码。
- 讲得简单但准确，抓住整体和主流程，支线细节简要带过。

## 运行项目

已接入本机授权、WebSocket、Agent 空快照及阶段二模型设置；草稿可编辑，发送尚未开放。消息只在后端进程内存中，重启后清空。

```sh
npm ci
npm run build
npm --prefix packages/server start
```

打开终端打印的完整授权链接，浏览器取得 Cookie 后自动跳转到干净地址。默认监听 `127.0.0.1:3000`；首次启动会安全创建 `~/.agent-learning/browser-auth.json`。不要分享授权链接。签名文件损坏或权限错误时服务拒绝启动，不会自动覆盖它。

从侧栏底部“设置 → 模型 → 添加提供方 → DeepSeek”保存 API Key，可替换或删除。Key 仅写入本机 `~/.agent-learning/auth.json`，页面只接收配置状态；多个页面会同步模型列表，重启后配置仍在。保存成功只表示本地配置可用，不表示远端认证通过。模型文件损坏仍可进入设置，但需要先人工修复文件，页面不会覆盖坏文件。

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

独立命令、系统输入法检查和说明见 [web/README.md](web/README.md)。本阶段实际证据见 [Feature2 验收记录](planning/里程碑1/feature2/feature2-验收记录.md)。
