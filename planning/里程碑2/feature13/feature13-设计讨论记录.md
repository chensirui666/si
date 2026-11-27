# 里程碑 2 Feature 13 Code Mode 设计讨论记录

## 已确认需求

模型可以提交一段程序。程序在一次 Code Mode 调用中执行多个工具，读到中间结果后决定下一步，再把选中的内容交回模型，供模型继续用户的任务。每次工具调用都遵守会话当时的权限。首版覆盖以下真实任务。 [里程碑范围](../README.md#第十三步code-mode)

1. 在真实项目中先查找候选文件，程序根据实际搜索结果选择要读的文件，只把选中的片段交回模型。验收时核对实际工具调用、程序的选择和模型的后续动作。
2. 调度多个一次性子 Agent 检查不同模块。程序校验答复中的模块名和问题列表，汇总有效结果，按是否发现问题或格式是否有效选择后续分支，再把选中的结果交回主模型。真实验收依赖 Feature 12 的前台委派。Feature 13 从已包含前台委派的 `main` 实现。 [Feature 12 委派设计](../feature12/feature12-Multi-Agent技术设计.md#32-委派子-agent-任务)
3. 在同一次脚本执行中发现并调用尚未直接提供给模型、当前会话有权使用的 MCP 工具，交回用户所需片段。

## 现状与参考

- SI 可以在一次模型回复中接收多项工具调用。需要根据实际结果决定下一步时，通常由模型在收到结果后发起新调用。会话会在工具执行前核对权限，并在工具结果回填时保存它。 [Agent 工具执行](../../../packages/agent/src/agent.ts#L100) · [会话权限与保存](../../../packages/coding-agent/src/agent-session.ts#L1088)
- Pi 在隔离环境中运行 JavaScript。程序通过会话提供的工具入口行动，工具入口沿用会话的校验和 Hook，也就是工具执行前后的扩展处理。Pi 将程序选出的输出交回模型，并记录内部调用及状态。 [Pi 程序执行](../../../pi/packages/coding-agent/src/extensions/codemode/execute.ts#L514) · [Pi 工具入口](../../../pi/packages/coding-agent/src/core/agent-session.ts#L791)
- SI 网页已有可展开的工具详情，显示模型提交的参数和服务端提供的结果。当前记录按模型发出的工具调用配对。DSH 用父子调用编号关联程序与内部工具，网页可以从程序展开查看调用。 [SI 工具详情](../../../web/src/components/AssistantMessage.tsx#L38) · [DSH 父子调用](../../../deepseek-harness/packages/client/ui-chat/src/client/model/tool-call-tree.ts#L64)

## 已确认决策

### 【功能决策｜会话、Agent】Code Mode 默认启用，原有工具仍可直接调用

启用时，符合权限的会话同时向模型提供 `codemode` 和原有工具，由模型按任务选择。默认启用，模型请求会增加 Code Mode 的工具说明。Pi 也支持两种调用方式并存，其终端由用户显式启用 Code Mode。本期按现有工具的方式提供 `codemode`。页面启停、工具禁用名单和统一工具管理留待后续单独设计。 [Pi 启用方式](../../../pi/packages/coding-agent/docs/cli.md#enable-codemode) · [Pi 并存设置](../../../pi/packages/coding-agent/docs/settings.md#tools)

### 【工程决策｜Coding Agent、Agent】复用 Pi Codemode SDK，SI 适配自己的工具

直接采用 `@earendil-works/pi-codemode` 的 Node `CodemodeSandbox`。SDK 已在独立线程里加载和启动 QuickJS，负责运行程序、把内部工具请求交给后端、收集输出和执行中止。SI 在 SDK 外提供适配器，将工具名和参数交给 SI 自己的会话工具执行链路，让权限检查和 Hook 继续生效，再把工具结果转成程序可使用的值。SI 负责把程序选出的输出回填给主模型，并用自己的会话记录和网页呈现执行状态。部署时需验证依赖安装后的 QuickJS 和 worker 文件能在实际 Node 入口加载。当前依据是本地源码和 SDK 文档。 [SDK Node 入口](../../../pi/packages/codemode/README.md#usage-on-node-and-bun) · [SDK 启动 QuickJS](../../../pi/packages/codemode/src/runtime/host.ts#L20) · [Pi 调用会话工具](../../../pi/packages/coding-agent/src/core/agent-session.ts#L791)

### 【功能决策｜会话、工具】三种模式开放 Code Mode，每个调用沿用当前权限

`codemode` 在普通、只读、计划模式都可使用。程序可使用本轮适合调用的工具，以及当前会话有权使用的 MCP 工具。只读和计划模式沿用各自的工具和参数限制。会话从普通切到只读时，已开始的工具按既有规则收尾。每项新调用在实际执行前核对最新权限，所以后续写入会被拦截，仍可读取。发起用户交互、改变会话流程和启动 Code Mode 的工具由模型直接调用。 [权限模式约定](../feature2/feature2-权限管理技术设计.md#31-切换会话权限并应用到工具调用) · [SI 会话权限检查](../../../packages/coding-agent/src/agent-session.ts#L266)

接入 Feature 12 后，程序通过 `subagent` 新建任务，传入 `background: false` 等待实际答复。 [Feature 12 委派方式](../feature12/feature12-Multi-Agent技术设计.md#委派工具-subagent)

### 【功能决策｜会话、MCP 工具】同一次脚本内发现并调用 MCP 工具

模型直接工具与脚本绑定各自组装。启动脚本时，SI 把已启用服务当前目录中会话有权调用的工具加入脚本绑定，包括尚未直接提供给模型的工具。脚本用 `searchTools()` 和 `describeTool()` 查询，再用同一次运行的绑定调用。实际工具请求沿用权限、参数校验、Hook 和调用记录。模型直接加载 MCP 工具继续使用 Feature 5 的 `tool_search`。 [Pi 可调用范围](../../../pi/packages/coding-agent/src/core/agent-session.ts#L1651) · [Pi 脚本发现](../../../pi/packages/coding-agent/src/extensions/codemode/execute.ts#L669) · [SI 会话工具提供](../../../packages/coding-agent/src/agent-session.ts#L234)

### 【功能决策｜聊天页面、会话】实时显示缩进的独立工具行，逐条保存调用

沿用 DSH `run_code` 的父子工具行结构。聊天中的 Code Mode 外层工具行可展开查看脚本和程序最终输出。内部每次调用都是外层工具行下方缩进的独立工具行，可单独查看工具名、参数摘要、状态和可用的失败原因。服务端按调用更新和保存，刷新网页后可接着看进度。服务重启后可回看已保存记录，只有开始记录的调用显示「结果未知」。主模型收到程序选出的输出。 [DSH 调用树](../../../deepseek-harness/packages/client/ui-tool/src/client/tool/ToolCallTree.tsx#L84) · [DSH 缩进样式](../../../deepseek-harness/packages/client/ui-tool/src/client/tool/ToolCallTree.module.css#L5) · [SI 服务中断后的查看方式](../../../docs/development.md#L11)

### 【工程决策｜会话、SQLite】沿用 SI 的 SQLite 逐条提交

内部工具在实际执行前确认开始记录已保存。工具返回后保存结果记录，再同步该调用的终态和交回程序。服务若在工具修改文件后、保存结果前退出，重开仍可看到调用和目标文件，状态显示「结果未知」。沿用现有的 SQLite 提交及保存失败处理。逐条提交的开销在调用较密集的程序中验证。 [SI 保存约定](../../../docs/development.md#L31) · [SI SQLite 提交](../../../packages/coding-agent/src/session-store.ts#L266)

DSH 将内部调用记录放进会话后后台批写，在外层工具执行前、下一次模型请求前等位置等待落盘。单次内部调用可能早于自己的记录落盘。SI 选择在每次调用前确认提交，沿用当前会话的中断恢复规则。将来若需把写入移到后台，仍可保留这个确认顺序。 [DSH 内部调用记录](../../../deepseek-harness/packages/core/tool-executor-ptc/src/ptc.ts#L497) · [DSH 异步批写](../../../deepseek-harness/packages/session/session-persistence-jsonl/src/storage.ts#L271) · [DSH 检查点策略](../../../deepseek-harness/packages/session/session-checkpoint-policy/src/index.ts#L52)

### 【工程决策｜Code Mode、会话】默认 5 分钟，单次最多 10 分钟

单次调用默认 5 分钟。模型可为这次程序指定正的时长，上限 10 分钟。计时包括等待执行名额、脚本运行和等待工具。到时停止脚本，向仍在运行的前台调用发出取消信号，按工具的实际结果收尾。已保存的调用结果和实际改动保留。超时原因与程序已产出的内容交回主模型。默认值取自 Pi SDK，单次上限参考 DSH。Pi CLI 默认不设整段时限。 [Pi SDK 默认时限](../../../pi/packages/codemode/src/runtime/execution.ts#L49) · [Pi CLI 时限](../../../pi/packages/coding-agent/src/extensions/codemode/execute.ts#L554) · [DSH Node 时限](../../../deepseek-harness/packages/ptc-runtime/ptc-runtime-node/src/config.ts#L41)

## 工具管理调研与本期范围

SI 现有会话权限与 MCP 服务启停分别限制一组工具或一个服务。Pi 通过默认工具名单启用 `codemode`，也能用 `--exclude-tools` 按名排除工具。DSH 通过 Agent 范围的工具过滤与执行器配置决定可用能力和调用方式。用户决定以后统一设计工具管理，本期直接把 `codemode` 纳入默认工具。先前讨论的专用开关和文件禁用名单随统一管理归入后续范围。 [SI 会话工具准备](../../../packages/coding-agent/src/agent-session.ts#L234) · [Pi 默认工具](../../../pi/packages/coding-agent/docs/settings.md#tools) · [Pi 排除规则](../../../pi/packages/coding-agent/src/core/agent-session.ts#L1626) · [DSH 工具筛选](../../../deepseek-harness/packages/core/tools/src/index.ts#L155)

## 流程对齐

执行一次 Code Mode 调用的主流程和模块分工已确认。新增的脚本工具绑定、MCP 查询和发送前复查已补入该流程并进入验收。 [流程 3.1](feature13-Code%20Mode技术设计.md#31-执行一次-code-mode-调用)
