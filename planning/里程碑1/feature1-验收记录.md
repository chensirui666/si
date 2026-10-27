# Feature1 验收记录

依据：[Feature1 技术设计 §6](./feature1-基本聊天页面.md#6-验收标准)。本记录区分组件测试、浏览器组件测试、实际应用入口和真实系统输入，不用其中一项代替另一项。

当前状态：页面实现、自动化验收与独立审查问题修复已完成；案例 4 的真实中文选字及实际 Safari 选字确认仍未验证，因此尚未宣布 PR 完成。

## 逐项对照

| 案例 | 验证范围 | 对应代码与证据 | 当前状态 |
| --- | --- | --- | --- |
| 1 | 拒绝空白；同批连续追加、重复文本、原文、user 角色、编号唯一稳定 | `web/src/pages/ChatPage.test.tsx`，StrictMode 下检查编号生成在更新函数外，UUID 失败不追加 | DOM 测试通过 |
| 2 | true 清空，false/异常保留原文和撤销历史 | `web/src/components/MessageInput.test.tsx`；点击/Enter 抛错均检查，另有 Enter 报错后的撤销与继续输入浏览器回归 | DOM 与 Chromium 组件测试通过 |
| 3 | 实际入口启动，发送后显示/清空/恢复焦点，无额外回复，刷新清空消息与草稿 | `web/tests/e2e/chat.spec.ts`；`npm run test:e2e` 自动启动页面，只运行本案例 | E2E 1/1 通过 |
| 4 | 普通 Enter、Shift+Enter、Ctrl/Cmd/Alt、repeat、空白及输入法事件 | `web/src/components/MessageInput.test.tsx`；真实中文输入法和实际 Safari 另见下方系统检查 | 自动化通过，真实选字待完成 |
| 5 | 逐字输入、真实粘贴、立即发送、空格/缩进/空行/末尾换行、最后几个字 | `web/src/components/MessageInput.browser.test.tsx` 四个独立用例，读取收到的 JSON 原文逐字比较 | Chromium 组件测试通过 |
| 6 | 旧消息位置、底部不跟随、多行发送/焦点、独立滚动、键盘滚动、输入区稳定 | `web/src/pages/ChatPage.browser.test.tsx`，挂载真实 ChatPage 及真实子组件，测量 scrollTop 与元素位置 | Chromium 组件集成测试通过 |
| 7 | 发送前撤销/重做，发送后无法恢复旧稿，新稿仍可撤销，提交次数不变 | `web/src/components/MessageInput.browser.test.tsx`；另有下一稿立即粘贴/撤销的 DOM 回归 | DOM 与 Chromium 组件测试通过 |
| 8 | 原文顺序、文字标签/Markdown不解析、排版/长文本、真实选区与复制、空列表、节点复用 | `web/src/components/MessageList.browser.test.tsx`；通过原生复制与 `navigator.clipboard.readText()` 精确比较末尾换行 | Chromium 组件测试通过 |

## 真实系统检查（案例 4）

- 已确认本机安装实际 Safari 与系统中文拼音输入源。
- 原生控制打开实际 Safari 的 `/tests/manual-input.html`，确认独立输入组件、空提交列表和真实 `trusted=true` 键盘事件可观察。
- 初次检查的输入源为 ABC；Control+Space/Control+Option+Space/Caps Lock 的操作后，系统配置最终显示 `com.apple.inputmethod.SCIM.ITABC`（拼音）。但在实际 Safari 刷新并重新聚焦后，通过原生控制逐键输入 `nihao`，仍只观察到英文和 `keydown trusted=true ... composing=false`，没有候选词或 composition 事件。配置中的输入源名称不能证明目标输入框已发生真实中文选字。
- 系统输入法菜单代理的原生控制连接超时；已请求使用者仅切换 Safari 输入源，之后仍由 Agent 执行候选词确认和结果核验。当前工具操作未产生可验证的真实组合输入，原因尚不能确定；不把这一环境限制改写成产品通过。
- 此处尚不能记为通过；粘贴“你好”、DOM 合成 composition 或 Playwright WebKit 都不构成真实中文选字证据。

## 已发现并处理的问题

1. 发送后第一份新草稿无法撤销：新增失败回归后调整清空历史的时机，使空编辑状态成为下一稿的历史基线。
2. 原生复制丢失末尾换行：原文后添加不改变 `textContent` 的 `<br />`，实际 Chrome 选区和剪贴板均保留原文。普通文字及一到两个末尾换行也经独立审查核对。
3. Enter 接收抛异常后撤销失效、继续输入漏字：独立审查在实际 Chrome 两次复现，点击发送路径正常。新增 Chromium 回归先复现失败，再在提交函数捕获接收异常，通过微任务报告给环境，让 Lexical 先正常结束更新。`onSend` 仍同步执行；回归确认环境收到 `reject`，撤销恢复原稿，后续逐字输入 `XY` 完整保留。

## 最终运行结果

2026-10-27，在分支 `codex/feature1-chat` 的最终实现上重新执行（非临时 Chrome 配置）：

| 命令 | 实际结果 |
| --- | --- |
| `cd web && npm test` | DOM 20/20、默认 Chromium 组件测试 8/8，通过，退出码 0 |
| `cd web && npm run test:e2e` | 唯一 E2E 1/1，通过，退出码 0 |
| `cd web && npm run build` | TypeScript 检查和 Vite 生产构建通过，退出码 0 |
| `git diff --check` | 无空白错误 |

运行环境为 Node.js 24.16.0、npm 11.13.0、Playwright 1.62.1、Chromium 151.0.7922.34（revision 1234）。浏览器结果分别保存为 `web/test-results/components.json` 和 `web/test-results/e2e.json`；测试源码全部保存在项目中，失败 trace 按测试类型分别存储，不互相覆盖。测试产物已忽略，不能代替源码。

独立审查检查了设计、生产代码、测试断言、React hooks/可访问性与参考源码，并给出一个需要修复的 Enter 异常问题；该问题已有先红后绿的回归及上述整套复跑。桌面 1280×800、窄屏 390×720 已进行实际页面截图检查，窄屏没有横向溢出。

**仍未覆盖：** 案例 4 的真实中文输入法确认候选词，以及实际 Safari 刚结束选字的 Enter。当前仅证明 Safari 页面可打开、英文原生键盘事件可观察；不能推导中文选字防误发已经通过。
