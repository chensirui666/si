# Feature7 验收记录

日期：2026-11-09。分支：`codex/feature7`。基线：`df1bf57`。位置：主目录下 `.worktrees/feature7`。

记录范围：以下为 Feature7 实施阶段在 worktree 中取得的历史验收证据。基础版本根测试 501 项、独立真实工具 7 项，合计 **508 项通过，0 失败、0 跳过**；后续文件清单增量的补验单列于文末。这些是实施阶段记录，主目录结果见[合并后复验](#合并后复验)。

已完成手动与自动压缩、摘要迭代、工具配对保留、容量圆环及分布、命令补全、分类回执、统一运行编号中止、同进程恢复、真实用量关联，以及一次明确超限恢复。原始聊天保留，正常任务 systemPrompt 与工具定义不被摘要替代。

设计及验收范围见[技术设计](./feature7-基础上下文压缩技术设计.md)与[验收标准](../../../planning/里程碑1/feature7/feature7-验收标准.md)；后续排期见[里程碑1规划](../../../planning/里程碑1/README.md)。

## 执行条件

用户指定 `download/.env`，实际文件为 `/Users/stardust/Downloads/.env`，包含 DeepSeek 与 Tavily 测试凭据。原文件只读，凭据经设置保存至临时测试目录；不记录凭据、授权 URL 或含凭据 trace。

正式模型为 DeepSeek Flash，目录容量 1,048,576、显式单次输出预算 65,536。真实压缩用例只在可信进程内采用触发预算 20,000、近期预算 400；正式默认近期 20,000、额外余量 16,384 不变。实际用量全部来自服务商 usage。

## 基础版本历史校验结果

根 `npm test` 最终退出码 0，**501 项通过，0 失败、0 跳过**。已提供真实 DeepSeek 文件，并用现有 `ToolRuntime.prepare` 校验下载官方 fd 到临时目录，仅为本次 PATH 添加它；根测试结束后临时目录已清理，没有全局安装。

| 校验 | 通过 | 失败 / 跳过 |
| --- | ---: | ---: |
| Credentials | 54 | 0 / 0 |
| Model | 67 | 0 / 0 |
| Agent（含压缩准备） | 76 | 0 / 0 |
| Server | 111 | 0 / 0 |
| 网页单元 | 132 | 0 / 0 |
| 真实 Chromium 组件 | 44 | 0 / 0 |
| Node/Vite 与真实服务商 E2E | 17 | 0 / 0 |
| 合计 | 501 | 0 / 0 |

构建、前后端 TypeScript 随根测试通过。根测试记录见 [full-suite.txt](./evidence/full-suite.txt)，[Chromium 汇总](./evidence/components-summary.json)和 [E2E 汇总](./evidence/e2e-summary.json)均无 flaky、失败或跳过。构建仍保留已有的 500 kB chunk 提示，不影响成功退出；未新增依赖。

七项独立真实工具最终复验 **7 项全部通过**（58.08 秒），见 [tools-live.txt](./evidence/tools-live.txt)：bash、edit、write、find、grep、web_search、web_fetch 的执行、回填和最终回答均核对；read 在实际网页 E2E 中验证。与根测试合计 508 项通过，0 失败、0 跳过。

### 同一真实网页会话的两次压缩

同一网页会话内先手动、后自动完成两次成功压缩。对照请求使用同模型、逐字相同的 systemPrompt 与工具定义，以及同一验证输入；对照回复不进入任务历史，也不执行工具。实际数据来自服务商 usage，摘要调用消耗另记。

| 触发 | 同输入压缩前实际 token | 压缩后实际 token | 摘要调用 input / output |
| --- | ---: | ---: | ---: |
| 手动 | 13,449 | 3,155 | 10,814 / 539 |
| 自动 | 39,290 | 29,625 | 6,693 / 771 |

[原始脱敏数据](./evidence/feature7-live-evidence.json)记录模型、实际容量、测试预算、两条压缩编号与真实用量。三次 read 找到真实线索、项目及新批次，一次 write 生成 JSON；逐项核对早期交付编号、地区、新负责人、项目更正、格式更正、工具批次和最终文件内容。第二次依赖第一次摘要中的早期交付编号，未把原始历史或标准答案塞回压缩后的问答。普通 systemPrompt 与八个工具定义全程保持原样，刷新后成功记录和后续实际用量引用均恢复。

### 68 个案例的证据归属

| 案例 | 实际覆盖位置 | 核对内容 |
| --- | --- | --- |
| 01–07 | `packages/agent/test/compaction.test.ts`、`agent-compaction.test.ts` | 无候选、重复压缩、配对边界、Unicode 头尾及 2,000 字符边界、旧摘要更新 |
| 08–10 | `agent-compaction.test.ts`、`packages/model/test/context-estimate.test.ts`、`model-stream.test.ts`、真实 case68 | systemPrompt/tools 保持原样、带工具历史思考与完整请求估算、无工具省略思考 |
| 11–16 | `packages/model/test/model-stream.test.ts` | 明确超限安全分类，普通参数/认证/限流/网络错误不恢复，缺失与部分 usage 不造 input |
| 17–18 | `agent-compaction.test.ts` | 首次真实 input 引用实际摘要，独立命令回执不追加聊天 |
| 19 | `packages/server/test/webserver.test.ts` | 正式授权 HTTP/WS 接收与 runId 中止 |
| 20–33 | `agent-compaction.test.ts`、`agent.test.ts` | 忙碌拒绝，批次完成后自动压缩，候选拒绝，容量不足停止，取消等待，一次恢复与新工具轮次重置，不重放工具 |
| 34–39 | `packages/server/test/webserver.test.ts`、网页 client/state 测试 | success/failed/aborted 重连、切点序号、大历史快照及真实慢连接清理 |
| 40–47 | `MessageInput.browser.test.tsx`、`MessageInput.test.tsx` | 斜杠发现、匹配、点击/Tab/Enter 仅补全、Esc、普通路径与无匹配 |
| 48 | `MessageInput.test.tsx` | 合成 composition 事件、选字 Tab/Enter 与刚结束保护；不代表真实系统输入法 |
| 49–52 | `MessageInput.browser.test.tsx`、`ChatPage.browser.test.tsx` | 普通移焦、撤销/重做、忙碌可编辑补全但不可发送、失焦关闭 |
| 53–55 | `ChatPage.test.tsx`、chat client/state/submission 测试 | 命令与正式记录合并、迟到回执、新草稿不覆盖、拒绝与十秒未确认 |
| 56–62 | `ContextMeter.browser.test.tsx` | hover、键盘/Esc、未知/零/超量、压缩即时下降与 390px 可读性 |
| 63–67 | `CompactionRecords.test.tsx`、`ChatPage.test.tsx` | 原聊天保留、估算/真实/摘要消耗分开，未知不补零，失败/停止/未执行提示 |
| 68 | `web/tests/e2e/compaction.live.spec.ts` | 真实同网页会话两次对照、摘要迭代与事实、真实工具续做和最终 JSON、刷新恢复 |

另补真实 Chromium 菜单关闭后清空重输同前缀回归，以及大快照发送期间快速替换 100 次订阅和通知更新回归。

## 独立审查与修复

独立审查核对 Model/Agent/Server/网页实际调用链。未发现 Critical 问题；发现命令菜单关闭标记跨草稿保留。按“新草稿无法再次发现命令”的实际影响纳入修复：真实 Chromium 回归先失败，再修正草稿变化时使旧关闭标记失效，通过后再运行全套。

大历史验收先复现 3 MiB 快照尚未发完就被更新触发缓冲保护断开；改为等待发送完成，仅合并尚未开始发送的同类通知，发送中发生的新变化会再通知；保留心跳慢连接清理。补测订阅快速替换，取消的订阅不积压大快照。

基线有 find 中止 ready 等待超时与未等待异步断言的连带异常。受影响工具代码未被盲目修改；测试立即收集结果，并在 finally 中止并等待已启动进程，以启动前文件事件监听替代任意一秒轮询，工具提前结束立即失败，保留原测试五秒总时限、中止原因与未写文件断言。

## 边界

- 摘要与工具结果头尾截取可能丢信息，不保证任意任务无损。
- token 是固定字符密度估算，中文与 JSON 可能低估；总占用与三类估算不必相等，真实用量分列。
- 超限识别与一次恢复通过受控服务商响应测试；未主动制造真实远端的超限拒绝，不声称覆盖所有远端格式。
- 输入法保护已用合成事件验证，未操作真实系统中文输入法或 Safari；Chromium 不能代替这些证据。
- 原始历史和摘要只在本进程内保存，重启恢复仍待后续落盘。按主目录最新规划，Session 是第八步，项目说明加载为第九步，本地存储是第十步。
- 本记录不代替当前提交、合并状态或合并后的验收结果。

## 文件清单补验（2026-11-09）

补齐 `read`、`write`、`edit` 的确认路径记录与压缩摘要清单。单元测试核对空文件、失败与中止、压缩边界、路径去重和重复压缩。真实网页会话核对第一次压缩后的文件清单进入实际模型请求，第二次保留早期文件，刷新后可在「查看摘要」展开核对，最终实际写入结果仍正确。

根测试首次 503 项通过，三项旧真实模型用例报请求或响应读取错误，另有一项 `find` 因缺少 `fd` 跳过。三项真实模型用例定向复跑均通过，`find` 使用校验过的临时 `fd` 单独补跑通过。合计 507 项回归用例通过。另有真实 `edit`、`write` 独立验收两项通过。

## 合并后复验

2026-11-09，Feature7 以快进方式合并到本地 `main`，验证代码提交为 `20d9cb1`。在主目录重新执行 `npm test` 和七项独立真实工具验收，使用用户已指定的测试凭据及校验过的临时 `fd`。

| 校验 | 最终通过 |
| --- | ---: |
| Credentials | 54 |
| Model | 67 |
| Agent | 78 |
| Server | 112 |
| 网页单元 | 135 |
| Chromium 组件 | 44 |
| Node/Vite 与真实模型 E2E | 17 |
| 七项独立真实工具 | 7 |
| 合计 | **514** |

根测试首轮 503 项通过，四项旧 DeepSeek E2E 报请求或响应读取错误。独立真实工具首轮六项通过，`web_fetch` 的后续模型请求报读取错误。定向复跑期间记录到 DeepSeek `ECONNRESET`，上述五项最终均在同一代码版本的 `main` 上通过。统计按用例去重，无未通过或未覆盖的自动校验。

Feature7 真实会话重新通过两次压缩与文件续做。手动压缩实际输入从 13,409 降至 3,254 token，自动压缩从 39,351 降至 29,839 token。清单进入后续模型请求，正常 systemPrompt 与工具声明保持一致，实际写入的文件内容正确。[主目录真实验收证据](./evidence/main-feature7-live.json)

确认上述校验后删除 `.worktrees/feature7` 和本地分支 `codex/feature7`。Feature7 定稿文档与验收证据已归档。主目录原有的文档整理保留在工作区。
