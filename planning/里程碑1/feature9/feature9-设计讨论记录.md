# Feature9 项目说明加载与启动上下文设计讨论

## 已确认的需求

用户于 2026-11-10 确认。会话开始工作时自动加载所属项目的说明，用户只需提交任务。说明进入实际发给模型的普通任务请求，压缩旧对话后仍然可用。不同工作区使用各自的说明，同一工作区的会话可以共用说明，聊天历史各自保存。没有说明的工作区也可以正常聊天。[里程碑 1 第九步](../README.md#第九步项目说明加载与启动上下文)

## 已确认的功能决策

### 1. 【功能决策｜会话层】按 Pi 发现说明文件

用户于 2026-11-10 选择按 Pi 的规则。从会话绑定的工作区开始，逐级向上检查，包含文件系统根目录。`~` 位于这条路径上时一起检查。每个目录依次寻找 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`，取第一个能读到的普通文件。若候选无法读取，继续检查下一个候选。[工作区目录校验](../../../packages/server/src/workspaces.ts#L64) · [Pi 候选文件](../../../pi/packages/coding-agent/src/core/resource-loader.ts#L184) · [Pi 祖先遍历](../../../pi/packages/coding-agent/src/core/resource-loader.ts#L232)

按 Pi 分层组织模型输入，先放应用配置目录的全局说明，再从最外层祖先到工作区排列各目录的说明。全局目录默认取本应用现有的 `~/.agent-learning/`，对应 Pi 的 `~/.pi/agent/`。工作区外的祖先说明和全局说明也会随普通任务请求发给模型。[Pi 全局配置目录](../../../pi/packages/coding-agent/src/config.ts#L604) · [Pi 分层顺序测试](../../../pi/packages/coding-agent/test/resource-loader.test.ts#L440) · [本应用的配置目录](../../../packages/server/src/workspaces.ts#L25)

### 2. 【功能决策｜会话层】更新时机

用户于 2026-11-10 要求参考 DSH 的更新方式。DSH 在首个模型请求前加载说明，后续在模型准备发起新一轮请求时核对已适用的说明。文件版本未变时可复用已有结果，新增、改写或删除时把变更交给模型。成功的 `read`、`write`、`edit` 还可发现工具触达的子目录说明。DSH 把变更作为有来源的消息加入会话历史。[DSH 请求前准备](../../../deepseek-harness/packages/context/agent-instructions/src/index.ts#L334) · [DSH 版本核对](../../../deepseek-harness/packages/context/agent-instructions/src/state.ts#L371) · [DSH 说明文档](../../../deepseek-harness/packages/context/agent-instructions/README.zh.md#understand-the-implementation)

用户于 2026-11-10 确认更新时机跟 DSH，查找范围和提示词组织跟 Pi。会话在每次普通模型请求前检查已确定的目录链，包括工具执行完继续调用模型的轮次。下一次请求使用当时有效的说明，正在执行的请求使用发出时的版本。继续按已确认的 Pi 规则确定目录链，工具访问子目录不会扩大说明范围。当前有效说明作为独立的一段系统提示词交给模型，旧聊天仍按原有规则压缩。每轮多一次文件检查，用户或工具在任务中修改说明时，同一任务的后续模型请求可能用到新版。[当前逐轮准备入口](../../../packages/agent/src/agent.ts#L39) · [当前会话上下文](../../../packages/coding-agent/src/agent-session.ts#L91) · [Pi 说明拼装](../../../pi/packages/coding-agent/src/core/system-prompt.ts#L79)

### 3. 【工程决策｜项目说明读取】候选文件是符号链接时的处理

Pi 和 DSH 都会跟随指向普通文件的符号链接。DSH 文档建议在文件系统策略或操作系统沙箱里约束链接能到达的范围。本应用的工作区用于定位目录，本地服务仍有读取用户配置文件的权限。若下载的仓库把 `AGENTS.md` 指向本机凭据文件，直接沿用跟随链接的规则会把目标文件内容随任务发给模型。[Pi 文件读取](../../../pi/packages/coding-agent/src/core/resource-loader.ts#L184) · [DSH 的链接说明](../../../deepseek-harness/packages/context/agent-instructions/README.zh.md#known-limitations-and-deferred-work) · [本应用的凭据文件路径](../../../packages/credentials/src/credentials.ts#L83)

用户于 2026-11-10 确认跟随 Pi 的设计。候选文件是符号链接时，目标是可读的普通文件就使用其内容，保留候选路径作为说明来源。目标不存在、不是普通文件或无法读取时继续检查同一目录的下一候选。接受说明文件可能指向所选工作区之外的文件，其内容随任务发送给模型的风险。

### 4. 【工程决策｜项目说明读取】项目说明超出读取预算

用户于 2026-11-10 确认按 Pi 的设计保留选中说明的全文。整段说明随普通任务进入现有模型容量检查。可通过整理旧聊天恢复容量时，使用现有压缩流程。说明自身已经超出模型可用容量时，现有任务错误提示用户精简说明，保留已有聊天和工具结果。独立的 64 KiB 预算和截断规则不适用。[Pi 文件读取](../../../pi/packages/coding-agent/src/core/resource-loader.ts#L184) · [当前模型容量检查](../../../packages/coding-agent/src/agent-session.ts#L217)

一般读取失败沿用 Pi 的候选回退。候选缺失时继续查找，其他读取错误在本地服务日志记录路径和原因，再尝试下一候选。记录不包含文件内容。

## 流程对齐

用户于 2026-11-10 确认流程图没有问题。对「每轮一份项目说明」和系统提示词组成的说明已并入技术设计。流程图和对应模块说明见[技术设计 §3](./feature9-项目说明加载与启动上下文技术设计.md#3-系统设计)。用户随后要求在独立 worktree 继续实现并完成校验。
