# 里程碑 2 Feature 13 Code Mode 验收记录

日期为 2026-11-27。工作分支为 `codex/milestone2-feature13`，基线为 `main` 的 `0f7a763`，其中已包含 Feature 12 的前台委派。

## 受控校验

根 `npm test` 退出码为 0。后端各包 808 项、网页单元 162 项、Chromium 组件 101 项、端到端 67 项，共 1,138 项通过。默认配置跳过 27 项需要外部服务的用例，Feature 13 的 4 项在下节另行实测。MCP 公开客户端身份文件校验和 `git diff --check` 通过。

| 案例 | 核对结果 | 测试入口 |
| --- | --- | --- |
| 01、06 | 普通会话同时声明 Code Mode 与直接工具。脚本根据真实查找结果选中文件，原外层调用只回填一条选中的结果。既有直接读取与回填用例通过。 | [真实 Node 入口](../../../web/tests/e2e/code-mode.spec.ts) |
| 02–05 | 只读和计划模式沿用工具权限。计划中的 Git 写操作、运行中切到只读后的写入、文件保护 Hook 命中的编辑都被拦截。 | [Coding Agent 测试](../../../packages/coding-agent/test/codemode.test.ts) |
| 07–08 | 并行读取分别结算。前台委派的一项失败后，脚本仍按原顺序取得另一项的实际答复。 | [Coding Agent 测试](../../../packages/coding-agent/test/codemode.test.ts) · [前台委派端到端](../../../web/tests/e2e/subagent-tasks.spec.ts) |
| 09–12 | 超限输入在启动前拒绝。超时保留已输出内容，用户中止等待在途操作收尾。已接单的后台 Bash 可在原会话查询和停止。 | [Coding Agent 测试](../../../packages/coding-agent/test/codemode.test.ts) |
| 13–15 | SQLite 拒绝开始记录时文件未改。文件写入后强制结束 Node 进程，重启可见子调用「结果未知」，续做时外层恢复提示包含实际目标。Chromium 复测刷新后的独立状态及展开详情。 | [Coding Agent 测试](../../../packages/coding-agent/test/codemode.test.ts) · [重启端到端](../../../web/tests/e2e/code-mode.spec.ts) · [Chromium 组件测试](../../../web/src/components/AssistantMessage.browser.test.tsx) |
| 16–17 | 受控 MCP 端点在脚本搜索后收到一次真实协议请求。第二次运行在搜索后停用服务，旧绑定被拒绝，端点未收到第二次调用。两轮的模型工具声明都未加载该工具。 | [MCP 端到端](../../../web/tests/e2e/code-mode.spec.ts) |

另用本地 Pi 的原版 `protected-paths.ts` 实测了脚本内 `edit`。扩展拦截了临时 `.env`，记录保留子调用编号和原始拒绝原因。压缩实测保留了子调用确认的读写文件，并按外层调用编号交回一条工具结果。

进程内两个执行名额占满时，额外脚本的等待时间计入时限。中止后可继续接收新脚本。40 个并行子调用在本机临时会话库中产生 80 次保存，累计约 11.9 毫秒。这个数值只含保存调用。

## 真实模型校验

真实用例从 Chromium 发出消息，由 DeepSeek Flash 编写脚本并继续回答。每项从模型请求核对外层结果按编号回填一次，并从网页核对实际子调用。测试凭据经现有设置入口载入临时配置。有凭据的浏览器测试关闭了 trace、截图和视频。 [端到端用例](../../../web/tests/e2e/code-mode.spec.ts)

| 案例 | 实测结果 |
| --- | --- |
| 18 | 通过。脚本从三个候选文件中选中 `current-plan.txt`，回填了含随机编号的首行。最终回答给出相同编号。 |
| 19 | 两个分支均通过。实际子会话分别读取 Alpha、Beta、Gamma 文件。脚本按任务顺序核对模块名和问题数组，将 Gamma 的自然语言答复列为需复核。Alpha 含随机问题标记和全无有效问题两轮分别返回 `HAS_ISSUES` 和 `NO_VALID_ISSUES`。 |
| 20 | 通过。脚本搜索 `microsoft_docs_fetch`、查看参数、发送实际文档 URL，再回填一级标题 `C# record types`。独立请求同一 MCP 得到相同标题。模型的直接工具声明未加载该工具。 |

GitHub MCP 尝试中出现连接重置及设置页连接超时。案例 20 采用 Microsoft Learn 公共只读服务完成。该服务通过 Streamable HTTP 提供文档查询。 [Microsoft Learn MCP 说明](https://learn.microsoft.com/en-us/training/support/mcp)

## 复跑

```sh
npx playwright install chromium
npm test
node --test deploy/mcp-client-identity/oauth.test.mjs
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env \
  npm --prefix web run test:e2e -- code-mode.spec.ts --grep '真实模型验收'
```
