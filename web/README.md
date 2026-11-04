# 本地聊天页面

Feature2 阶段三：页面通过授权后的 WebSocket 订阅唯一 Agent 的对话和生成状态，查询本机模型配置；模型可用、订阅就绪且没有未决提交或生成任务时可以发送。发送完整保留用户空格和换行，有效发起后立即清空本次草稿与撤销历史、恢复输入焦点；生成中仍可编辑下一条草稿。

HTTP 回执与 WebSocket 正式消息无论先后均合并为一个气泡。回执先到会继续等待订阅追上；网络失败或十秒没有接收证据时显示“未确认接收”并重取快照，空快照不证明未接收，不自动重发或恢复草稿。明确的 HTTP 4xx 拒绝显示失败，之后可重新人工发送；失败气泡保留在创建时的位置，不被后续已接收消息或回答挤到下方；5xx、无效回执和网络错误保持接收未知。刷新只恢复后端已接收内容，不恢复草稿、本地失败条目或思考展开状态；后端重启清空聊天。

回答正文安全展示 GFM Markdown，生成时冻结稳定前块、更新尾部，块结束和最终回复重新解析校准；禁止模型 HTML、脚本、危险链接与图片协议。跨稳定块引用在生成中可能暂时显示文字，结束后完整解析恢复链接。思考默认折叠，主动展开后在本页流式更新与结束时保留；工具请求仅显示名称、参数与参数错误，本阶段不执行工具。达到长度限制、工具请求、取消和调用失败均明确提示，失败时保留已生成内容。

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

- test:unit：DOM 输入、页面与设置、状态校验、客户端假时钟测试；覆盖完整模型帧应用、HTTP/WS 接收竞态、迟到错误、十秒未确认、4xx 明确拒绝、所有发送门禁与同步重复手势、安全 GFM、草稿保护、配置与重连。
- test:browser：真实 Chromium 组件测试，覆盖三类内容、五种终止、思考展开保持、GFM 安全与最终校准、HTTP/WS 两种先后顺序；保留原文、剪贴板、撤销、焦点、流式增长中的阅读位置、字体、窄屏与低高度回归。受控快照只用于页面测试，不代表后端生成。
- test:e2e：先完整构建，启动实际 Node 后端和 Vite；验证授权、Cookie、WS、设置、受控 SDK/SSE 经真实后端的流式回答、历史、刷新/断线/多页面恢复与重启。真实 DeepSeek 用独立 live 用例验证，是否实际执行与结果以验收记录为准。
- 根 npm test：依次执行全部自动校验。

浏览器组件测试使用系统剪贴板，单 worker 顺序执行；组件端口 3100、Vite E2E 5173 需空闲，Node E2E 使用临时端口。结果在 test-results/；E2E 为避免记录启动令牌和 Cookie 不保存 trace，仅保留干净页面截图。签名文件、模型文件和日志使用临时目录，测试后清理。

真实中文输入法和实际 Safari 必须单独实测，不能由合成事件或 Chromium 代替。开发服务启动后，`/tests/manual-input.html` 是独立的输入诊断页，允许将文字提交到页面内诊断记录；它不提交聊天。用系统拼音输入 nihao 并选字，确认确认键不发送；结束组合输入后再主动 Enter，应正常记录。应用聊天页在模型、连接、提交或生成门禁未满足时禁发送但允许编辑。未实测范围如实记录于验收文档。

## 组织方式

App 装配页面；ChatPage 维护对话、模型选择与本地提交接收证据；chat/client 管配置与提交 HTTP、WebSocket 与重连，chat/state 校验编号、连续序号并应用三类内容块与最终结果；models_changed 单独触发查询，不进入对话序号。SettingsDialog 使用 Radix Dialog 管理键盘、焦点与关闭后的焦点返回。MessageInput 内的 Lexical 管草稿、选区和撤销。状态变化不会重挂输入框，sendDisabled 只阻止发送；MessageList 保留独立滚动与阅读位置。

类型通过各包公开入口以 import type 引用，浏览器不加载后端实现。Model 类型归 Model，快照归 Agent，网络帧归 Server/protocol。视觉继续遵守 design.md 的 760px 居中内容列、白底、14/24px 正文和紧凑输入。

结果见 [Feature2 验收记录](../planning/里程碑1/feature2/feature2-验收记录.md)；历史功能见 [Feature1 验收记录](../planning/里程碑1/feature1/feature1-验收记录.md)。
