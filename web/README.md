# 本地聊天页面

Feature1 只提供文字输入、发送和用户消息展示。页面没有模型回复；消息和未发送草稿只在当前页面内存中，刷新或关闭后清空。

## 启动

建议沿用本机 Node.js 24.16.0、npm 11.13.0；兼容范围见 `package.json` 的 `engines`，依赖版本保存在 `package-lock.json`。

```sh
cd web
npm ci
npm run dev
```

打开终端显示的本机地址，默认是 `http://127.0.0.1:5173/`。输入文字后点击“发送”或按 Enter；Shift+Enter 换行。中文选字、其他修饰键 Enter 和长按重复 Enter 不发送。空白内容不能发送。

## 构建与验收

```sh
npm run build
npx playwright install chromium
npm test
npm run test:e2e
```

- `npm run test:unit`：DOM 组件测试，验证消息接收契约、草稿保护、发送按键与模拟输入法事件。
- `npm run test:browser`：真实 Chromium 组件测试，加载实际样式，验证文字输入、原生粘贴/复制、撤销历史与阅读位置。只挂载所需组件，不经过应用入口。
- `npm test`：依次运行上述两组组件测试。
- `npm run test:e2e`：只运行案例 3，自动启动本机测试服务，从真实应用入口检查发送和刷新清空。

浏览器测试使用系统剪贴板，按一个 worker 顺序执行。运行结果在 `test-results/`，失败 trace 也在其中；这些产物不提交。测试端口为组件测试 3100、E2E 4173，需保持空闲。

真实中文输入法和实际 Safari 需单独操作。启动开发服务后打开 `http://127.0.0.1:5173/tests/manual-input.html`：该页面只挂载输入组件，显示实际接收到的提交和原生输入事件。用系统中文拼音输入 `nihao`，按空格选出“你好”，确认草稿保留、提交记录仍为 `[]`；另行用 Return 结束组合输入，确认该次 Enter 不发送。选字结束后再主动按 Enter，应正常发送。实际结果由 Agent 记录在验收文档，不以模拟事件或 WebKit 替代。

逐项结果见 [Feature1 验收记录](../planning/里程碑1/feature1/feature1-验收记录.md)。

## 组织方式

`App` 装配页面；`ChatPage` 保存已发送的用户消息；`MessageInput` 内的 Lexical 管理草稿、选区和撤销；`MessageList` 只读展示原文。输入框随草稿增高，到上限后在内部滚动；低高度和触摸屏分别调整可用高度和操作目标。消息列表单独滚动，输入框增高、发送清空和恢复焦点时保持阅读位置，发送后不自动跟随底部。

视觉按 [design.md](../design.md) 实现：白底、近黑主操作、浅灰用户消息，760px 居中内容列，正文与输入 14px/24px。发送按钮只显示向上箭头，保留可访问名称“发送”；空白稿为浅灰禁用，有效稿为黑底白图标。

输入框保持弱化边界与固定轻微阴影 `0 2px 12px 0 rgba(0, 0, 0, 0.04)`，常态和聚焦一致，不加粗、不加外圈。消息滚动区无框；消息区与按钮以局部小点提示键盘定位，消息区小点不随内容滚动，输入位置由光标标示。按钮用背景变化反馈悬停和按下。

标题只显示“聊天”，不再显示“本地”；输入区不常驻显示“Enter 发送 · Shift+Enter 换行”提示，快捷键行为保持不变。

三款字体及许可证随应用提供，来源与覆盖范围见 [字体目录说明](public/fonts/README.md)。当前聊天正文、标题与控件使用 Noto Sans CJK SC；EB Garamond 与 Noto Sans Mono CJK SC 在对应的品牌/代码角色使用时加载。完整正文可变字库约 14.25 MB，换取无需假设用户会输入哪些汉字；没有额外运行时字体服务或 npm 依赖。

Button 源码来自 [shadcn/ui 官方 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json)，本地调整类名工具路径、Slot 导入及交互样式；焦点使用项目统一的局部标记，替代默认光圈。主题由 Tailwind CSS 提供。接入依据：[Vite 安装说明](https://ui.shadcn.com/docs/installation/vite)、[Lexical React](https://lexical.dev/docs/getting-started/react)、[Lexical 更新与状态读取](https://lexical.dev/docs/concepts/updates)。
