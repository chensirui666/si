# Feature1 验收记录

依据：[Feature1 技术设计 §6](./feature1-基本聊天页面.md#6-验收标准)。本记录区分组件测试、浏览器组件测试、实际应用入口和真实系统输入，不用其中一项代替另一项。

当前状态：页面实现、独立审查问题修复及全部八组验收已完成。案例 4 已取得真实系统中文输入法与实际 Safari 证据；输入法确认键按系统行为校正，并已获用户明确认可。

## 逐项对照

| 案例 | 验证范围 | 对应代码与证据 | 当前状态 |
| --- | --- | --- | --- |
| 1 | 拒绝空白；同批连续追加、重复文本、原文、user 角色、编号唯一稳定 | `web/src/pages/ChatPage.test.tsx`，StrictMode 下检查编号生成在更新函数外，UUID 失败不追加 | DOM 测试通过 |
| 2 | true 清空，false/异常保留原文和撤销历史 | `web/src/components/MessageInput.test.tsx`；点击/Enter 抛错均检查，另有 Enter 报错后的撤销与继续输入浏览器回归 | DOM 与 Chromium 组件测试通过 |
| 3 | 实际入口启动，发送后显示/清空/恢复焦点，无额外回复，刷新清空消息与草稿 | `web/tests/e2e/chat.spec.ts`；`npm run test:e2e` 自动启动页面，只运行本案例 | E2E 1/1 通过 |
| 4 | 普通 Enter、Shift+Enter、Ctrl/Cmd/Alt、repeat、空白及输入法事件 | `web/src/components/MessageInput.test.tsx`；真实系统拼音和实际 Safari 另见下方系统检查 | DOM、真实中文输入法与实际 Safari 补充检查均通过 |
| 5 | 逐字输入、真实粘贴、立即发送、空格/缩进/空行/末尾换行、最后几个字 | `web/src/components/MessageInput.browser.test.tsx` 四个独立用例，读取收到的 JSON 原文逐字比较 | Chromium 组件测试通过 |
| 6 | 旧消息位置、底部不跟随、多行发送/焦点、独立滚动、键盘滚动、输入区稳定 | `web/src/pages/ChatPage.browser.test.tsx`，挂载真实 ChatPage 及真实子组件，测量 scrollTop 与元素位置 | Chromium 组件集成测试通过 |
| 7 | 发送前撤销/重做，发送后无法恢复旧稿，新稿仍可撤销，提交次数不变 | `web/src/components/MessageInput.browser.test.tsx`；另有下一稿立即粘贴/撤销的 DOM 回归 | DOM 与 Chromium 组件测试通过 |
| 8 | 原文顺序、文字标签/Markdown不解析、排版/长文本、真实选区与复制、空列表、节点复用 | `web/src/components/MessageList.browser.test.tsx`；通过原生复制与 `navigator.clipboard.readText()` 精确比较末尾换行 | Chromium 组件测试通过 |

## 真实系统检查（案例 4）

实际环境：macOS 26.7.1、Safari 26.6.2、系统简体拼音 `SCIM.ITABC`。页面为 `http://127.0.0.1:5173/tests/manual-input.html`，只挂载真实 `MessageInput`；测试 Harness 在浏览器本地同步记录 `onSend` 调用并返回 `true`，`[]` 明确表示没有发生接收调用。

用户明确授权后，Agent 使用 AppleScript/System Events 激活 Safari 并发送系统键码；通过原生可访问性状态和截图检查编辑框、提交记录及页面记录的真实输入事件。未使用合成 composition、粘贴汉字或 Playwright WebKit 来代替本项。

| 实际操作 | 观察到的输入事件 | 草稿与调用结果 | 结论 |
| --- | --- | --- | --- |
| 在系统拼音中逐键输入 `nihao`，按 Return 结束组合输入（另以数字键盘 Enter 复核） | `compositionstart/update` 为 `trusted=true`，输入过程 keyCode 229；`compositionend ... nihao` 后出现 `keydown Enter composing=false code=229` | 草稿 `nihao` 保留，提交记录 `[]` | 实际 Safari 在刚结束组合、`isComposing=false` 的确认 Enter 上没有误发 |
| 清空后重新输入 `nihao`，按系统拼音的空格确认汉字候选 | `compositionend trusted=true 你好`，随后 `keydown ... composing=false code=229` | 草稿 `你好` 保留，提交记录 `[]` | 真实中文候选确认没有调用 `onSend` 或清空草稿 |
| 选字完成后再次主动按 Return | `keydown trusted=true Enter composing=false code=13` | 提交记录精确为 `["你好"]`，草稿清空，输入焦点恢复，按钮禁用 | 输入法结束后正常的发送仍然可用，且只提交一次 |

可重复的系统键盘序列如下；各阶段结束后由 Agent 读取页面显示的草稿、`已提交原文` 和 `原生输入事件`。运行前打开上述独立组件页并聚焦“消息”编辑框；输入 `nihao` 的物理键码依次为 `45, 34, 4, 0, 31`，Return 为 `36`，空格为 `49`，数字键盘 Enter 为 `76`。

```applescript
tell application "Safari" to activate
tell application "System Events"
  key code 45
  key code 34
  key code 4
  key code 0
  key code 31
  key code 36 -- 第一项；第二项将此行改为 49，选出“你好”。
end tell
```

**经用户确认的系统按键校正：** [Apple 官方说明](https://support.apple.com/zh-cn/guide/chinese-input-method/cim12992/mac)规定大多数中文输入法用空格确认候选，Return 确认特别列给注音/倚天注音。本机拼音实测 Return 确认的是拼音原文。因此不把“Return 结束拼音组合”写成“Return 确认汉字你好”；分别记录上述三项实测。用户于 2026-10-27 明确认可据此校正文档并完成案例 4，功能要求仍为输入法确认不误发、之后普通 Enter 正常发送。

此前的 CUA `pressKey/typeText` 只产生英文、系统菜单代理超时，均未记为通过；取得用户授权并观察到真实组合输入后，才完成本项。

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

**覆盖边界：** 真实系统输入法补充检查覆盖上述本机系统拼音与实际 Safari；没有将结果扩展宣称为所有操作系统、所有中文输入法或其他 Safari 版本均已实测。Feature1 所要求的八组验收已全部完成。
