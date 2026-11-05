# Feature3 实施计划

> 执行时遵循 superpowers:test-driven-development；先验证失败，再完成最小实现。用户于 2026-11-05 要求在新 worktree 继续实现并完成校验。

**目标：** 提供四工具声明，通过 Model 发送给 DeepSeek，并验证最终调用接收。

**架构：** Server 持有具体声明，Model 只接受通用 `Tool`。调用方使用独立上下文，等待同次 `result()`；不执行工具或接入普通聊天。

**工具链：** 现有 TypeScript 5.9.3、Vitest、OpenAI SDK；TypeBox 优先锁定与本地 Pi 一致的 1.3.27，以实际构建验证兼容性。

**设计依据：** [Feature3 设计](./feature3-工具定义与调用接收.md)。

## 全局边界

- 沿用设计中的四工具字段、可选性，不增加数字或数组限制。
- 省略或传空 `tools` 时不发 SDK `tools`，不自动载入默认工具。
- 返回参数保持待校验，未知名称、缺必填字段、解析错误仍保留。
- 仅 `stop`、`toolUse` 交付调用；`length`、`error`、`aborted` 保留最终消息但不交付。
- 不修改 Agent、WebServer 或网页流程，不执行命令或文件操作。
- 真实案例显式单独运行，使用现有 Credentials，不重试、不记录凭据。

## 重点检查

声明省略及空数组；无效参数编号/名称保留；未知名称及缺字段；工具参数出现后的取消/失败/截断；四个真实案例参数与任务一致。

## Task 1：工具声明与 Model 接入

**文件：** `packages/server/src/tools.ts`、`packages/server/test/tools.test.ts`；`packages/model/src/{types,index,deepseek}.ts`、`packages/model/test/model-stream.test.ts`；两包 package.json 与根锁文件。

**接口：** Model 导出 `Tool<TParameters extends TSchema = TSchema>`，`ModelContext.tools?: Tool[]`；Server 导出 `defaultTools` 与四种参数类型。

- [x] 写声明规则、请求转换、空数组和编号名称断言，观察新行为失败。
- [x] 安装锁定的 TypeBox；完成四工具与 SDK 请求转换。
- [x] 构建全部后端包，运行 Model 与 Server 定向单元/集成测试。

## Task 2：独立调用方与真实模型验收

**文件：** `packages/server/test/model-tools.test.ts`、`model-tools.live.ts`、`packages/server/vitest.tools-live.config.ts`、Server package.json。

**接口：** 使用现有 `createModelStream(credentials, { fetch? })`、`defaultTools` 与 `result()`，只在测试中提取调用，无生产专用接口。

- [x] 补齐四声明经过真实 SDK、未知名称、缺字段及所有最终状态检查。
- [x] 四种独立真实任务检查正常结束、名称和准确参数；输出任务、原编号、参数、原因及判定。
- [x] 单独运行 `test:tools:live`，无凭据记录待执行，有凭据真实请求并记录实际结果。

## Task 3：全量回归、独立审查与记录

**文件：** Model/根 README、规划状态与 Feature3 验收记录。

- [x] 运行根 `npm test`（后端、网页单元、Chromium 组件、实际入口 E2E）及完整构建。
- [x] 独立审查最终修改，修复影响本次行为的问题并验证。
- [x] 将实际命令、通过数量和未覆盖项写入验收记录，更新实施状态与使用说明。

## 执行记录

- 基线：后端 146、网页单元 81、Chromium 组件 27 通过；入口 E2E 4 通过、3 失败、1 跳过。失败根因为旧 Feature2 Vite 占据固定 5173，测试误认其就绪；最终回归临时释放端口并恢复旧服务。
- RED→GREEN：Model 发送声明测试 1 失败/47 通过 → 48 通过；四声明测试因模块未实现 5 失败 → 5 通过。独立调用方 10 项定向检查通过。
- 兼容性：TypeBox 1.3.27 与 TypeScript 5.9.3 构建通过，未升级工具链。SDK 参数使用 schema 的对象展开，满足 SDK 字典类型并保留实际 JSON 规则。
- Pi 对照：四工具与分层一致；本期有意省略工具声明历史、执行和结果回填循环。
- Worktree：`.worktrees/feature3`，分支 `codex/feature3`；复制主目录未提交的规划修改，主目录保持原样。
- 最终验证：根 `npm test` 278 通过、1 项旧 Feature2 真实网页案例按配置跳过；Feature3 真实模型 4/4 通过；严格测试类型检查与最终 Server 43 项复跑通过；独立审查无发现。完整事实及首轮真实失败见[验收记录](./feature3-验收记录.md)。
- 未扩展：执行前校验、工具结果回填、循环及声明历史均遵循设计留到后续；本期无其他审查遗留项。

## 合并主干与清理

用户随后要求合并并在主目录重新验证，2026-11-05 已完成：

- 实现提交 `cd2a9d7` 已快进合并到 `main`；主目录原规划修改完整纳入提交，临时合并备份在核对后清理。
- 主目录 `npm ci` 通过；使用用户指定的 `/Users/stardust/Downloads/.env` 运行根 `npm test`，279 项通过，无跳过。此前未运行的真实网页模型案例也通过。
- 主目录四工具真实案例 4/4 通过；相关测试及配置的严格 TypeScript 检查通过。合计 283 项通过。
- 测试期间临时释放 5173，结束后已恢复原 Feature2 Vite 服务并确认 HTTP 200。
- 验证通过后已普通删除 `.worktrees/feature3`、删除已合并分支 `codex/feature3`，未清理其他 worktree、分支或既有 stash；未推送远端。
