# 里程碑 2 Feature 6 长期 Memory 验收记录

日期为 2026-11-23。验证在 `codex/milestone2-feature6` worktree 中进行。

## 出处改动验收

`npm test` 共 979 项通过，包括 672 项后端测试、159 项网页单元测试、94 项 Chromium 组件测试和 54 项端到端测试。默认套件跳过 20 项需要外部凭据的用例。用例 23 单独通过真实模型验证。

用例 23 在 Chromium 中用 `deepseek-flash` 真实运行。同一句「可以」分别确认一次性操作和长期约定。前者执行当次操作，项目笔记为 0 且没有个人记忆文件。后者实际保存 `8f79a771f428490a.md`，由程序记录会话 `6000d0ff-20d1-4afb-a06d-96f56b91e6f7`，保存时间为 `2026-11-23T09:08:24.447Z`。

新会话 `a2992362-52bd-4615-82da-b1438064f3a3` 首次询问测试准备时，模型用 `read` 取笔记并使用测试库和迁移约定。用户随后问怎么确认时，`memory_source` 返回上述写入会话与当时的对话。模型在实际网页回复中引用「迁移没有过，就不要开始跑」和「可以」。测试同时核对了真实出站请求中工具调用与结果的配对。 [真实网页测试](../../../web/tests/e2e/memory.spec.ts)

受控测试覆盖旧格式与手动编辑、重复提交、归并、同仓库授权、跨项目拒绝、来源缺失、分页、保存时间边界，以及关闭后的历史清理。 [存储测试](../../../packages/coding-agent/test/memory-store.test.ts) · [会话测试](../../../packages/coding-agent/test/memory-session.test.ts) · [回查测试](../../../packages/coding-agent/test/memory-source-tool.test.ts)

回查返回每页最多六条普通对话。它依赖已有的会话历史。会话与写入时间用于缩小出处范围，出现不完整片段时由模型根据实际读到的原话回答。

## 初版全量校验

| 命令或入口 | 结果 |
| --- | --- |
| `npm test` 中的后端测试 | 663 项通过 |
| `npm test` 中的网页单元测试 | 159 项通过 |
| `npm test` 中的 Chromium 组件测试 | 94 项通过 |
| `npm test` 中的生产服务和 Vite 网页端到端测试 | 54 项通过，20 项需单独提供外部凭据 |
| Chromium 中的真实 DeepSeek Flash 验收及回归 | 6 项通过，包含用例 23、连续读取、写入、压缩和重启恢复 |
| `npm --prefix packages/server run test:tools:live` | 7 项通过，覆盖文件和命令工具，以及实际 Tavily 搜索与抓取 |

默认全量校验共 970 项通过。真实模型在下列用例中单独验收。

## 初版用例与证据

| 用例 | 检查结果 |
| --- | --- |
| 01–08、31 | 会话提供真实的本轮消息编号，磁盘记录消息位置和发送时间。重复写入保持原文件，补充使用同一条目的新版本，过期版本被拒绝。只读和计划模式拒绝写入，提交前取消保留原文件。个人容量失败返回超出量及最新条目，旧轮消息编号不可作为新来源。 [会话测试](../../../packages/coding-agent/test/memory-session.test.ts) · [存储测试](../../../packages/coding-agent/test/memory-store.test.ts) · [工具测试](../../../packages/coding-agent/test/memory-tool.test.ts) |
| 09–18、30 | 首轮提供个人全文、项目目录和对应的用量。笔记正文经实际 `read` 返回。同一仓库的 worktree 共享，独立克隆分开，本轮目录和开关保持固定。压缩或重新开启后读取最新个人记忆。关闭后的请求省去旧记忆工具内容，调用与结果仍配对。到期项在普通模式清理，受限模式省略并保留文件。目录按 200 条和 24,000 UTF-8 字节提供完整行。 [会话测试](../../../packages/coding-agent/test/memory-session.test.ts) · [存储测试](../../../packages/coding-agent/test/memory-store.test.ts) |
| 19–22 | Chromium 从设置保存真实个人 Markdown，并在新会话的实际模型输入中查到它。项目摘要读取实际目录，关闭记忆后仍可删除笔记，后续会话中的目录同步移除。版本冲突保留草稿，可在打开的弹窗对照最新版，再按更新后的版本保存。 [端到端测试](../../../web/tests/e2e/memory.spec.ts) · [设置组件测试](../../../web/src/components/SettingsDialog.browser.test.tsx) · [服务端测试](../../../packages/server/test/webserver.test.ts) |
| 23 | Chromium 使用实际 DeepSeek Flash。第一会话收到项目测试约定，调用 `memory` 保存，磁盘可读到目录、笔记与来源。第二会话只询问怎么准备集成测试。出站请求先带目录，再带对应 `read` 结果，最终回答使用笔记里的测试库名和迁移检查。 [真实模型用例](../../../web/tests/e2e/memory.spec.ts) |
| 24–29 | 个人归并与新增一起保存并保留旧来源。超限或并发版本冲突使整批保留原文。第 201 条被拒绝后受控模型还可执行真实文件读取并结束任务。目录 24,000 字节、笔记 4,000 字节可保存，分别多一字节时保留旧版。 [会话测试](../../../packages/coding-agent/test/memory-session.test.ts) · [存储测试](../../../packages/coding-agent/test/memory-store.test.ts) · [工具测试](../../../packages/coding-agent/test/memory-tool.test.ts) |

用例 23 的复跑使用 `deepseek-flash`。第一会话 `c0649dc2-18b4-48a3-8fc3-c98ef16480ca` 的 `memory` 工具返回 `saved`，笔记为 `1579410180074c59.md`，版本为 1。第二会话 `cbe8227d-f69c-4203-8aa0-cbb2a435d444` 发起的 `read` 对应同一笔记，结果随调用编号进入后续请求。回答写明测试库 `si_test_7fb28a11` 和运行前确认迁移已完成。数据库名是测试数据，两个会话都使用临时工作区。

旧工具回归的 `edit` 用例首次出现回答措辞偏差。验收提示明确要求报告文件中「状态」字段的新值后，复跑同时通过磁盘内容和回答检查。

## 实现取值

- 个人 Markdown 上限按技术设计取 1,375 个 Unicode 字符。一个 SI 服务进程负责同一个应用数据目录中的记忆读写。
- Git 项目归属核对 worktree 的相互指向。使用外置 Git 元数据且缺少可验证主目录对应关系的仓库，主目录与 worktree 可能各自形成项目记忆。
