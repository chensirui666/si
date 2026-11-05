# Feature3 验收记录

日期：2026-11-05。状态：**实现与本期验收完成，改动尚未提交或合并主干**。

工作目录：`/Users/stardust/agent learning/.worktrees/feature3`，分支 `codex/feature3`，起点 `ea2aa4e`。主目录尚未提交的 Feature3 设计及相关规划修改已复制到该 worktree，主目录文件保留原样。

## 交付

- Server 提供 `read`、`bash`、`edit`、`write` 四种声明及 TypeBox 推导的参数类型。
- Model 公开 `Tool`、支持可选 `ModelContext.tools`，将本次非空声明转换为 SDK 函数工具；省略和空数组均不发送 `tools`。
- 返回内容保持待校验：未知名称、缺少必填字段、JSON 参数错误仍保留。独立验收调用方等待最终消息，仅在 `stop`、`toolUse` 时取得调用。
- 本期不执行工具、不回填结果、不进入循环、不写普通聊天历史，网页聊天继续省略工具声明。
- Model 与 Server 均锁定 TypeBox `1.3.27`，与本地 Pi 一致；现有 TypeScript `5.9.3`、Node `24.16.0`、npm `11.13.0` 未升级。

## 自动校验

根 `npm test` 最终退出码为 0，含完整构建、全部离线测试与实际入口 E2E：**278 项通过，1 项跳过**。

| 范围 | 结果 |
| --- | --- |
| Credentials | 53 通过 |
| Model | 48 通过 |
| Agent | 19 通过 |
| Server | 43 通过 |
| 网页单元测试 | 81 通过 |
| 真实 Chromium 组件测试 | 27 通过 |
| Node/Vite 实际入口 E2E 及凭据解析 | 7 通过，1 跳过 |

跳过项为既有 Feature2 的真实网页模型验收 `真实 DeepSeek 设置、两轮历史、流式进度与无效 Key 恢复`，原因是未提供 `DEEPSEEK_LIVE_KEY_FILE`；不能据本轮结果声称该案例重新通过。Feature3 四个真实模型案例已独立实际执行，见下节。

T1 由 `tools.test.ts` 的 5 项测试验证四声明、用途、字段、必填与类型、数字可选性、空 `edits` 和空文本。M1/M2 由现有 Model 测试新增 2 项请求检查及编号/名称保留断言覆盖。M3/M4 由 `model-tools.test.ts` 的 10 项测试覆盖四声明实际进入 SDK、待校验数据保留、正常交付、纯文字空列表，以及工具参数出现后的截断、失败和取消。

额外验证：

- `npm run build:packages`：通过，验证 TypeBox 与现有工具链兼容。
- 修改涉及的 Model 测试、三个 Server 测试及 live 配置执行独立严格 TypeScript 检查：通过。曾发现工具测试直接访问通用 `TSchema` 的属性无法类型检查，已改为属性断言与显式收窄，随后 Server 43 项复跑通过。
- `git diff --check`：通过。
- 独立只读代码审查：无 Critical、Important 或 Minor 发现；审查者另行复跑 61 项相关测试通过。

## 真实 DeepSeek 四案例

命令：`npm --prefix packages/server run test:tools:live`。最终 **4/4 通过**，运行约 5.55 秒。

使用现有 Credentials 只读本机配置，每个任务各有独立上下文并传入全部四种声明。SDK 与测试重试均关闭；未执行任何工具、未操作任务中的文件、未写普通聊天历史。输出仅包含任务、调用编号、名称、参数、结束原因与判定，无凭据、认证头或原始服务商异常。

| 任务 | 实际名称及参数 | 原调用编号 | 结束原因 | 判定 |
| --- | --- | --- | --- | --- |
| 使用 read 读取 note.txt，从第 1 行开始，最多 5 行 | `read`：`{"path":"note.txt","offset":1,"limit":5}` | `call_00_ET_ij7fq5PZxNhe6ODBIz138972` | `toolUse` | 通过 |
| 使用 bash 运行 pwd，超时 10 秒 | `bash`：`{"command":"pwd","timeout":10}` | `call_00_W4R0OfRRCT5rfxwHBUyj5328` | `toolUse` | 通过 |
| 使用 edit 将 note.txt 中的“旧内容”替换为“新内容”，以 edits 数组描述 | `edit`：`{"path":"note.txt","edits":[{"oldText":"旧内容","newText":"新内容"}]}` | `call_00_CMfkOc2XRCuHbFIDOQPL6477` | `toolUse` | 通过 |
| 使用 write 将文本你好写入 draft.txt，content 只含这两个字 | `write`：`{"path":"draft.txt","content":"你好"}` | `call_00_RMCqktjgFH3RHc31auZM8266` | `toolUse` | 通过 |

首轮实际结果为 3 通过、1 未通过：`edit` 任务返回 `read({"path":"note.txt"})`，编号 `call_00_roevQBxWInY8nSt7DVaG3571`，结束原因 `toolUse`。模型选择了先查看文件，因此按指定工具名与参数的断言判失败。

随后将验收系统提示明确为“只验收一条用户指定工具的声明，用户已给出本次需要的路径和原文，不为检查文件或环境先调用其他工具”，再显式运行四个案例。最终结果如上；保留首轮失败，不以自动重试掩盖。该结果证明明确任务下的声明接入与调用接收，不保证任意自然语言请求都直接选择指定工具。

## 基线与环境处理

首轮完整基线中，后端 146 项、网页单元 81 项、Chromium 组件 27 项通过；入口 E2E 4 通过、3 失败、1 跳过。三个失败均发生在 Vite 入口：旧 Feature2 worktree 的 Vite 占用 `127.0.0.1:5173`，既有测试就绪检查误认旧服务的 HTTP 200，授权请求实际得到旧代理的 502。

最终完整回归期间临时停止该旧 Vite，释放固定端口；测试通过后已用原工作目录、启动参数与后端端口配置恢复，`/@vite/client` 返回 200。未修改网页或测试辅助代码来掩盖端口冲突。

构建仍有既有的网页单块大于 500 kB 提示，基线与最终构建的资源大小一致；未扩展为拆包优化。未重新进行真实系统输入法或 Safari 人工验收，本期无网页功能变更。

## Pi 对照与后续边界

四工具字段、TypeBox 单份规则、应用层具体声明与 Model 通用声明的职责均与 Pi 一致。本期按设计省去工具集变更历史；Pi 在截断后还会回填失败结果并继续循环，本期仅保留最终消息、不交付调用并结束。

声明和本地类型不代表执行许可。名称、具体参数规则、路径、权限、编辑匹配和超时限制必须在后续执行前检查；本次没有实现这些执行能力。
