# Feature4 验收记录

日期 2026-11-06。实现位于 `codex/feature4-implementation`，从本地 `main` 的 `98eb839` 建立独立工作树。

## 验收结果

| 场景 | 结果 | 实际核对 |
| --- | --- | --- |
| M1、A1、A2 | 通过 | 首轮完整结束后才执行。批次编号异常时无工具执行。结果按调用编号回填。第二次请求省略工具，整个任务结束才解除发送门禁。带工具的后续消息保留此前思考。 |
| W1、W2 | 自动化通过 | HTTP 实测取消无写入、别名复用同一工作区、重启恢复绑定而对话为空。缺少绑定、编号不符或目录失效时，模型调用次数保持为零。真实写入发生在绑定目录。 |
| P1、P2 | 通过 | 分别保存能力选择与 Tavily Key。添加、替换、删除和通知均只返回状态，DeepSeek 凭据继续可用。注入单一能力的厂商验证通用接口。旧选择可读为 Tavily，并显示独立的凭据状态。 |
| T1 `read` | 真实通过 | Chromium 经授权、工作区和对话入口发送任务。实际读取 `note.txt`，页面可展开真实结果。文件内容从「青禾」改为「白榆」后，新回答和回填请求均包含更新值。 |
| T2 `bash` | 真实通过 | DeepSeek 请求 `ls`，回填包含临时工作区的 `draft.txt`、`note.txt` 和退出码，回答列出文件。 |
| T3 `edit` | 真实通过 | 首次模型先选了 `read`。将验收输入明确为已读原文和完整替换参数后，模型调用 `edit`，磁盘内容从「开发中」变为「测试中」。 |
| T4 `write` | 真实通过 | 在临时工作区生成 `notes/note.txt`，确认父目录及 UTF-8 文件内容。 |
| T5 `find` | 真实通过 | 查找子目录的 `*.txt`，返回 `matched.txt`。另在 PATH 缺少 `fd` 时验证了官方下载、SHA-256 校验和运行。 |
| T6 `grep` | 真实通过 | 命中 `note.txt` 第 2 行「状态：开发中」，返回第 1、3 行上下文。 |
| T7 `web_search` | 真实通过 | DeepSeek 请求 Tavily Search，回填包含真实标题、链接和片段，最终回答引用第一条结果链接。 |
| T8 `web_fetch` | 真实通过 | DeepSeek 请求 Tavily Extract 获取 `https://1.1.1.1/` 的正文。回填包含原网址和实际页面正文，最终回答给出正文中的 Cloudflare 与原网址。 |
| E1、E2 | 通过 | 精确匹配优先，行尾普通空格回退，保留未修改字节及 BOM。重叠、多处命中、引号差异或混合换行均在写前拒绝。 |
| UI1–UI4 | 通过 | Chromium 覆盖工作区门禁、迟到拒绝后的草稿保护、跨消息工具结果关联、过程区展开与收起、共享 Key 表单。 |

真实 macOS 选择框已打开并验证取消返回空值。第二次测试未能确认选中了指定临时目录，原生选取成功待复验。

T1–T8 都核对实际工具执行、调用编号、结果回填和最终回答。T1 走浏览器入口，T2–T8 走正式 HTTP 和 WebSocket 接口。凭据从显式指定的测试文件读取，工作区和保存的凭据使用临时目录。Feature3 的四个独立真实案例已由这套验收替代，其声明、参数接收及执行门禁由现有底层测试覆盖。

## 运行命令

```sh
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env npm test

DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env \
TAVILY_LIVE_KEY_FILE=/absolute/path/to/test.env \
npm --prefix packages/server run test:tools:live
```

根 `npm test` 实际通过 328 项，无跳过。分别为后端 207 项、网页单测 82 项、Chromium 组件 30 项和浏览器端到端 9 项。后端验收的 PATH 使用测试临时目录内经 SHA-256 校验的官方 `fd`。收拢验收后复跑上述两条命令。独立真实工具命令仅运行 T2–T8，7 项通过，无跳过。另核对未指定测试凭据时，该命令只报告这 7 项跳过。

基线发现 5173 已被另一工作树的 Vite 占用。端到端测试现使用独立端口，两种实际入口均验证通过。Vite 生产构建仍报告已有的包体积提示。

## 实现边界

工作区提供路径起点。Bash 及文件工具以服务进程的本机权限执行。Bash 超时、写入失败或最终回答失败时，已经发生的文件变化可能保留。连续工具决策按计划留到第六步。正文工具对 DNS 返回代理占位地址的域名会提示无法验证公网地址。T8 选用公网 IP 页面，测试经过相同的公网检查和真实提取链路。

接口对照 [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) 和 [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)。
