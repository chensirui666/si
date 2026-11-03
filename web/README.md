# 本地聊天页面

Feature2 阶段二：页面通过授权后的 WebSocket 订阅唯一 Agent 的真实空状态，并查询本机模型配置。显示连接、恢复或异常提示；草稿始终可编辑，发送暂未开放。刷新会清空未发送草稿。实际聊天留到阶段三。

侧栏底部“设置 → 模型 → 添加提供方 → DeepSeek”可保存 API Key，已有配置可编辑或删除。Key 只写入后端本机文件，不回填页面；保存成功或关闭设置后清空新输入，不放入 localStorage、sessionStorage 或聊天历史。保存只表示本地配置可用，未验证远端。配置及外部文件变化会同步到所有连接页面，恢复连接后重新查询。

## 启动

使用 Node.js 24.16.0、npm 11.13.0；兼容范围见 package.json。依赖统一从仓库根安装，只有根 package-lock.json。

```sh
# 仓库根
npm ci
npm run build
npm --prefix packages/server start
```

打开后端打印的授权链接，取得 Cookie 后自动跳到干净页面。日常页面由 Node 提供，不依赖 Vite。

开发时分别运行根 `npm run dev:server` 和 `npm --prefix web run dev`，打开后端打印的 `http://127.0.0.1:5173/auth?token=…`。Vite 端口固定且被占用即报错；/auth 和 /api 代理保留 Host、Origin、Cookie。不能只启动 Vite 就认为已连接后端。

## 构建与验收

```sh
# 仓库根
npm run build
npm run test:packages
npm --prefix web run test:unit
npm --prefix web run test:browser
npm --prefix web run test:e2e
```

- test:unit：DOM 输入、页面与设置测试、状态校验与客户端假时钟测试，覆盖模型查询、配置增改删、输入清理、错误、草稿保护、旧帧隔离、快照就绪、退避、超时、离线及清理。
- test:browser：真实 Chromium 组件测试，保留原文、剪贴板、撤销、焦点、阅读位置、字体、窄屏和低高度回归。受控快照只用于页面测试，不代表后端生成。
- test:e2e：先完整构建，启动实际 Node 后端和 Vite，验证授权、Cookie、WS、真实 Agent 空快照、刷新/断线/离线/后端重启恢复及代理来源边界；两种入口均验证设置保存与替换、多页面同步、重启读回、删除和坏文件保护。
- 根 npm test：依次执行全部自动校验。

浏览器组件测试使用系统剪贴板，单 worker 顺序执行；组件端口 3100、Vite E2E 5173 需空闲，Node E2E 使用临时端口。结果在 test-results/；E2E 为避免记录启动令牌和 Cookie 不保存 trace，仅保留干净页面截图。签名文件、模型文件和日志使用临时目录，测试后清理。

真实中文输入法和实际 Safari 必须单独实测，不能由合成事件或 Chromium 代替。开发服务启动后，`/tests/manual-input.html` 是独立的输入诊断页，允许将文字提交到页面内诊断记录；它不提交聊天。用系统拼音输入 nihao 并选字，确认确认键不发送；结束组合输入后再主动 Enter，应正常记录。应用聊天页则始终禁发送。未实测范围如实记录于验收文档。

## 组织方式

App 装配页面；ChatPage 分别维护对话与模型配置；chat/client 管配置 HTTP、WebSocket 与重连，chat/state 校验当前编号与序号；models_changed 单独触发查询，不进入对话序号。SettingsDialog 使用 Radix Dialog 管理键盘、焦点与关闭后的焦点返回。MessageInput 内的 Lexical 管草稿、选区和撤销。状态变化不会重挂输入框，sendDisabled 只阻止发送；MessageList 保留独立滚动与阅读位置。

类型通过各包公开入口以 import type 引用，浏览器不加载后端实现。Model 类型归 Model，快照归 Agent，网络帧归 Server/protocol。视觉继续遵守 design.md 的 760px 居中内容列、白底、14/24px 正文和紧凑输入。

结果见 [Feature2 验收记录](../planning/里程碑1/feature2/feature2-验收记录.md)；历史功能见 [Feature1 验收记录](../planning/里程碑1/feature1/feature1-验收记录.md)。
