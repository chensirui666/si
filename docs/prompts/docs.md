# docs

## 用处

在用户询问 SI、编写 Skill 或创建子 Agent 角色时，指引模型查阅应用自带文档。

## 位置

[system-prompt.ts · docs](../../packages/coding-agent/src/system-prompt.ts#L53) 在存在应用文档目录且当前提供 `read` 时，将 `<docs>` 加入 `ModelContext.systemPrompt`。文档正文由模型随后按需读取。

```ts
const documentationRoot = '…' // SI 应用目录，用来定位 README.md、web/README.md 和 docs/skills.md。
const skillHome = '…' // 用户主目录，用来定位个人 .si/skills 目录。
const docs = '…' // 下方的文档指引段落，追加到 systemPrompt。
```

## 基础原文

以下是当前没有提供 `subagent` 工具时的文档指引。

```text
<docs>
SI 文档（用户询问 SI 本身，或要求创建、修改 Skill 时查阅）
- 主文档：${join(documentationRoot, 'README.md')}
- 补充文档位于 ${join(documentationRoot, 'docs')}。
- 从 SI 应用目录定位文档。文档里的相对链接以该文档所在目录为起点。
- 启动、模型配置、工作区、网页工具、中止和对话压缩见主文档。页面操作和开发校验见 ${join(documentationRoot, 'web', 'README.md')}。Skill 规则见 ${join(documentationRoot, 'docs', 'skills.md')}。
- 创建或修改 Skill 前，先用 read 完整阅读 Skill 规则文档，并查阅其中与本次任务有关的引用。个人 Skill 目录是 ${JSON.stringify(join(skillHome, '.si', 'skills'))}。
</docs>
```

## Feature 12 子 Agent 角色指引

会话同时提供 `read` 和 `subagent` 且能定位 SI 应用文档时，扩展查阅条件并加入角色创建指南。个人角色目录以用户主目录为基准。 [SI 组装位置](../../packages/coding-agent/src/system-prompt.ts#L53) · [Feature 12 技术设计 §3.1](../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md#31-从文件注册并发现子-agent-角色) · [Pi 按需查阅文档](https://github.com/earendil-works/pi/blob/db79712854e5154f48f10564c3f235abadfcefdc/packages/coding-agent/src/core/system-prompt.ts#L162) · [SI 子 Agent 角色创建指南](../subagents.md)

```text
SI 文档（用户询问 SI 本身，或要求创建、修改 Skill 或子 Agent 角色时查阅）
- 创建或修改子 Agent 角色前，先用 read 完整阅读 ${join(documentationRoot, 'docs', 'subagents.md')}。个人角色目录是 ${JSON.stringify(join(skillHome, '.si', 'agents'))}。
```
