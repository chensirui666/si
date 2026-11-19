# 里程碑 2 Feature 3 Skill 设计讨论

## 已确认的需求

用户能查看可用 Skill 及用途，也能在聊天中明确指定。Agent 能在匹配的任务中发现并读取 Skill，按需要使用附带的说明、参考材料和脚本。脚本执行与文件改动遵守当前会话权限。用户能要求 Agent 创建或修改 Skill，之后重新发现并使用。真实验收覆盖已有 Skill 指导任务，以及新建或修改的 Skill 在后续任务中产生可核对的结果。指定未知名称时按普通消息原样发送。已发现的 Skill 读取失败时，网页提示原因，消息仍按原文发送。 [里程碑规划](../README.md#第三步skill-的发现读取使用与创建) · [权限管理技术设计](../feature2/feature2-权限管理技术设计.md)

## 已确认的参考方向

沿用 Pi 的加载方式。模型先看到 Skill 的名称、用途和位置，匹配时用现有 `read` 读取目录指向的说明文件。用户可以从网页 `/` 菜单查看用途并填入 `/skill:名称`，或手动输入同一命令。发送后由服务端查找并读取正文，附上命令后的用户要求一起交给模型。参考材料的相对路径从说明文件所在目录起算。创建和修改复用现有文件工具。 [Pi Skill 说明](../../../pi/packages/coding-agent/docs/skills.md#understand-how-skills-load) · [Pi 显式调用](../../../pi/packages/coding-agent/src/core/agent-session.ts#L2307) · [DSH 网页候选与填入](../../../deepseek-harness/packages/client/ui-skill/src/client/index.ts#L167)

目录更新沿用 SI 草案。打开 `/` 菜单或接收新任务时重新扫描，运行中的任务沿用开始时的 Skill 列表。文件修改保存后，下次打开菜单或发送新任务就能发现，显式调用读取当时的正文。

## 已确认的发现规则

### 【功能决策｜工作区与 Skill 发现】自动发现项目 Skill，同名时项目优先

沿用 DSH 的自动发现体验，无需项目信任弹窗。目录范围和递归规则参考 Pi。按工作区的 `.si/skills/`、从工作区向上各级的 `.agents/skills/`、个人 `~/.si/skills/`、个人 `~/.agents/skills/` 的顺序查找。向上查找到最近的 Git 根并包含该层，非 Git 工作区向上查到文件系统根。个人 `~/.agents/skills/` 只按个人目录处理。同名时取最先发现的条目。项目 Skill 的正文可能影响模型选择下一步行动。脚本、命令和写入继续由当前会话的权限规则检查。 [Pi 应用目录](../../../pi/packages/coding-agent/src/core/package-manager.ts#L1009) · [Pi 查找各级 `.agents/skills/`](../../../pi/packages/coding-agent/src/core/package-manager.ts#L507) · [Pi 优先级](../../../pi/packages/coding-agent/src/core/package-manager.ts#L220) · [DSH 标准模式配置](../../../deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml#L40)

进入每个 Skill 目录后，递归查找 `SKILL.md`。遇到 `SKILL.md` 就把它所在的目录作为一个 Skill，停止往下找，避免把 `references/` 等配套文件识别成独立条目。沿用 Pi 的单文件兼容规则。`.si/skills/` 接受直属的 `.md`，`.agents/skills/` 接受子目录中的 `.md`，单文件均需有有效的 Skill 描述。 [Pi 递归发现](../../../pi/packages/coding-agent/src/core/package-manager.ts#L410) · [Pi 说明校验](../../../pi/packages/coding-agent/src/core/skills.ts#L294)

## 流程确认

- §3.1 发现并使用已有 Skill 的流程图和模块分工已确认。 [§3.1 流程](feature3-Skill技术设计.md#31-发现并使用已有-skill)
- §3.2 创建或修改 Skill 后继续使用的流程图和模块分工已确认。用户选择项目或个人范围，范围不清时在聊天中询问。新建遇到同名且没有指定路径时，请用户决定修改已有 Skill 或换名。 [§3.2 流程](feature3-Skill技术设计.md#32-创建或修改-skill-后继续使用)

## 基础设计确认

用户确认整稿，要求系统提示词沿用 Pi 的文档段写法。定稿明确文档位置、主题对应和创建或修改 Skill 前的阅读要求。完整规则维护在应用的 `docs/skills.md`。 [技术设计](feature3-Skill技术设计.md) · [验收标准](feature3-Skill验收标准.md)

## 首批 Skill 确认

用户确认首批提供创建 Skill、编写 `AGENTS.md` 和 `grill-me`。`agents-md` 的写入目标是当前工作区所属仓库根目录的 `AGENTS.md`。打开 SI 仓库时，SI 仓库就是本次目标。`grill-me` 采用 Matt Pocock 可独立运行的早期原版。 [首批 Skill](feature3-Skill技术设计.md#首批-skill)

用户认可预置 Skill 随应用存放在独立资源目录，采用项目、个人、预置的同名优先级。用户要改预置项时，在其选定的项目或个人目录保存副本。 [设计与分发](feature3-Skill技术设计.md#首批-skill)

## 菜单分组和来源

用户要求参考 DSH，在同一 `/` 菜单分开列出「命令」与「技能」，技能行右侧只显示「项目」或「个人」。DSH 的内置命令由应用代码注册，磁盘 Skill 由独立目录发现。SI 复用现有命令入口和已确认的 Skill 目录。 [技术设计 §3.1](feature3-Skill技术设计.md#31-发现并使用已有-skill)

## 整稿确认

用户确认当前整稿，包含首批三个 Skill、预置分发与覆盖规则、菜单分组和来源标签，以及 `agents-md` 面向当前仓库的写入规则。 [已通过的技术设计](feature3-Skill技术设计.md)

## 来源标签调整

用户要求把预置和个人分开显示。菜单和消息加载结果按实际采用的版本标注「项目」「个人」或「预置」。

## 命令与 Skill 的点选行为

用户确认沿用 DSH 的前端分流。确认 `/compact` 后直接提交压缩请求。确认 Skill 后在输入框填入可编辑的蓝色 `/skill:名称`，补充要求后可按原流程发送。
