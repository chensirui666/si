# Multi-Agent 提示词

**变更来源**　里程碑 2 Feature 12 Multi-Agent。 [技术设计](../../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md)

## 主会话的角色目录

准备主模型请求时，如果本轮提供 `subagent` 且有获准使用的角色，将角色名称和用途放入系统提示。选择角色后，由 `subagent.run` 按名称加载角色正文。创建或修改角色时，按 `<docs>` 的指引读取应用指南。 [Feature 12 角色发现设计](../../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md#31-从文件注册并发现子-agent-角色) · [Pi Skill 目录与按需加载](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/src/core/skills.ts#L358) · [应用文档指引](../docs.md#feature-12-子-agent-角色指引)

`{roleName}` 和 `{roleDescription}` 由获准使用的角色提供，每个角色展开一行。用途最长取 500 个字符。名称和用途都经转义后放入系统提示。 [角色目录组装](../../../packages/coding-agent/src/agent-session.ts#L357)

```text
<subagent_roles>
- {roleName}：{roleDescription}
</subagent_roles>
```

## 子会话的系统提示与首条任务

子会话沿用 SI 的基础系统提示，按实际工作目录加载项目说明和适用的 Skill。前后台共用下方的身份指令，`{name}` 是子会话名称。指定角色时，在身份指令之后追加角色 Markdown 正文。最终答复交回发起者。 [SI 基础系统提示](../systemPrompt.md) · [Pi 追加角色正文](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/examples/extensions/subagent/index.ts#L420) · [Pi P2 通用指令](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/apps/p2/plugins/subagents/tools.ts#L581)

```text
你是子 Agent「{name}」，为主 Agent 工作。完成交给你的任务，简洁作答。最终答复会报告给发起者。工作中可用 team 联系主 Agent 或同级子 Agent。
```

首条任务是子会话中的用户消息。`{task}` 包含发起方交代的任务和必要背景。续用时在原会话中追加本次输入，继续使用已有历史。 [Pi 首条任务](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/examples/extensions/subagent/index.ts#L434) · [Feature 12 委派设计](../../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md#32-委派子-agent-任务)

```text
Task: {task}
```

## `subagent` 工具说明

只提供给主会话。系统提示的工具清单显示「委派、续用和管理独立子 Agent。」下方完整说明随模型工具声明发送。 [SI 工具源码](../../../packages/coding-agent/src/subagent-tools.ts#L34) · [Pi 编码扩展工具说明](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/examples/extensions/subagent/index.ts#L617) · [Pi P2 完成报告](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/apps/p2/plugins/subagents/tools.ts#L396) · [Feature 12 委派设计](../../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md#32-委派子-agent-任务)

```text
把任务交给独立子 Agent。run 提交单个 task、并行 tasks 或串行 chain 三者之一。每项可指定 agent 角色、唯一 name、本机 cwd。串行步骤中的 {previous} 替换为上一步答复。run 和 continue 必须明确 background：false 等结果，true 先接单，结束后会回报。continue 用 sessionId 或 name 从原历史开启空闲子会话。steer 给运行中的子 Agent 插话，当前步骤收尾后送达。stop 停止指定子 Agent。status 查询指定子 Agent，省略目标时列出自己派出的子 Agent。
```

## `team` 工具说明

只提供给子会话。系统提示的工具清单显示「与主 Agent 和同级子 Agent 协作。」下方完整说明随模型工具声明发送，投递动作按 SI 的 `continue` 和 `steer` 协议执行。 [SI 工具源码](../../../packages/coding-agent/src/subagent-tools.ts#L34) · [Pi P2 团队工具说明](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/apps/p2/plugins/subagents/tools.ts#L672) · [Feature 12 协作设计](../../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md#33-投递当前轮插话与后台报告)

```text
联系直属主 Agent 或同级子 Agent。以 sessionId 或唯一 name 指定收件人，name 为 parent 时联系直属主 Agent。continue 从目标已有历史启动新轮，必须提供 message 和 background；false 等答复，true 先接单、完成后回报。steer 用 message 给正在运行的目标插话，当前步骤收尾后送达。answer 读取同级子 Agent 最近完成的答复。list 列出其他同级子 Agent 及状态。只在帮助推进任务时发消息。
```
