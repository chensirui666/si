# 里程碑 2 Feature 10 人机协同验收记录

对应 [验收标准](feature10-人机协同验收标准.md) 和 [技术设计](feature10-人机协同技术设计.md)。分支为 `codex/milestone2-feature10`。

## 受控案例

表内的模型响应由测试安排。浏览器用例通过真实 Chromium 页面，服务端集成用真实 HTTP、WebSocket 和 SQLite。关闭及崩溃恢复分别使用 SIGTERM 和 SIGKILL。

| 案例 | 核对内容 | 测试 |
| --- | --- | --- |
| 01 | 刷新后队列仍按原序。当前任务沿用 DeepSeek Flash 低档，随后两条任务分别使用 Kimi K3 高档 | [模型切换](../../../web/tests/e2e/model-selection.spec.ts) |
| 02、09、11 | 行内编辑取消与重试保持原编号。带图队列只允许整条操作。插话从待提交至正式历史保持同一条，并在整批工具结果后进入请求 | [人机协同网页](../../../web/tests/e2e/collaboration.spec.ts) |
| 03、06–08、12–13、15–17、19 | 图片条目删除、计划待审、进程关闭和崩溃恢复、转换状态竞态、插话顺序，以及跨会话与重复回答校验 | [人机协同服务端](../../../packages/server/test/collaboration-webserver.test.ts) |
| 04–05、10、22 | 失败或回滚后暂停队列。纯文字步骤接续插话。截止时同时回答只生成一条原超时结果和一条补答 | [会话状态](../../../packages/coding-agent/test/collaboration.test.ts) |
| 14、18、20–21、23–25 | 中止和重开后恢复等待中的插话。逐题作答与原截止时间。超时后关闭或补答。等待中的原任务中止后保留已做操作 | [人机协同网页](../../../web/tests/e2e/collaboration.spec.ts) · [会话状态](../../../packages/coding-agent/test/collaboration.test.ts) |
| 26–27 | 手动权限模式允许反问，文件写入沿用原权限。定时任务收到强制反问仍能收尾。默认及单次等待方式、合法范围、计时和工具回填分别核对 | [会话状态](../../../packages/coding-agent/test/collaboration.test.ts) · [定时任务](../../../packages/server/test/schedule-webserver.test.ts) · [反问参数](../../../packages/coding-agent/test/user-question-tool.test.ts) · [人机协同网页](../../../web/tests/e2e/collaboration.spec.ts) |

另测了自动压缩保留同批插话、纯文本模型拒收图片插话但保留原排队项、删除最后一条待发消息后可重新排队，以及定时任务完成后继续人工队列。 [压缩](../../../packages/coding-agent/test/compaction.test.ts) · [会话状态](../../../packages/coding-agent/test/collaboration.test.ts) · [人机协同服务端](../../../packages/server/test/collaboration-webserver.test.ts) · [定时任务](../../../packages/server/test/schedule-webserver.test.ts)

## 真实 DeepSeek 验收

用例 28 通过真实 Chromium 聊天入口、DeepSeek Flash 和临时工作区执行。真实模型把网页选择的「保留旧接口」写入插话指定的 `decision.txt`，继而按队列顺序生成 `first.txt` 和 `second.txt`。三个文件字节一致，`before.txt` 只记录一次，`result.txt` 未生成。读取关闭服务后的 SQLite 确认三轮按序完成，插话仍归属第一轮，反问和工具结果通过原编号配对。测试在本地生成 `web/test-results/feature10-live-evidence.json`。 [用例脚本](../../../web/tests/e2e/human-collaboration.live.spec.ts)

## 全量回归

- `npm test` 退出码为 0。737 项后端测试、161 项网页单测、94 项 Chromium 组件测试、59 项端到端测试通过，共 1,051 项。根命令按配置跳过 21 个依赖真实服务的用例，其中 Feature 10 的用例 28 使用单独的测试入口运行。
- `node --test deploy/mcp-client-identity/oauth.test.mjs` 通过 1 项。`git diff --check` 通过。
- 浏览器测试在本地生成 `web/test-results/components.json` 和 `web/test-results/e2e.json`。
