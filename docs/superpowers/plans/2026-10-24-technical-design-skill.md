# Technical Design Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安装一个可跨仓库使用、尊重用户设计决策权的技术文档 skill。

**Architecture:** 一个主工作流、一份完整模板、最小 UI 元数据。产品源码不改；模拟验证使用临时工作区。

**Tech Stack:** Markdown、YAML；已有 Python 校验工具。

**Spec:** ../specs/2026-10-24-technical-design-skill-design.md

## Global Constraints

- 关键决策按对系统的影响识别，不以 Agent 是否拿得准为判断标准。
- 需求理解、关键决策、模块内容和最终文档分别需要用户明确批准。
- 当前项目约定和用户材料决定参考源码，不固定 Pi。
- 按功能模块讨论，批准内容才写入文档，最后整体核对。
- 支持回退；保留未受影响批准。完整保留用户模板。
- 个人 skill 默认放在 ~/.codex/skills；不覆盖现有文件、不提交或推送。

## Review Focus

- 需求材料完整但需求理解尚未批准：仍停在第一阶段。
- 技术方案明确或只有一个合理方案：重要选择仍待用户确认。
- 用户已批准需求：不重复索要第一阶段批准。
- 后续改变已确认接口或数据：重新确认受影响部分。
- 测试未执行、参考源码不存在：不得写成已验证或捏造证据。

## Task 1: 创建并验证 skill

**Files:**
- Create: /Users/stardust/.codex/skills/technical-design/SKILL.md
- Create: /Users/stardust/.codex/skills/technical-design/references/technical-design-template.md
- Create: /Users/stardust/.codex/skills/technical-design/agents/openai.yaml
- Test: 隔离临时目录中的场景与原始回复记录。

**Interfaces:**
- Consumes: 已批准设计、用户完整模板、项目本地源码与约定。
- Produces: 可由 $technical-design 发现并执行的三阶段文档工作流。

- [x] 先运行不加载 skill 的对照场景，记录重要选择未逐项展开确认的实际回复。
- [x] 初始化 skill，编写流程并复制完整模板；不引入脚本或运行时依赖。
- [x] 使用五个独立上下文重复测试关键决策场景，并测试需求批准、模块回退和最终整理。
- [x] 根据对照缺陷编写逐项决策规则；启用 skill 后未出现需要进一步修正的阻塞失败。
- [x] 运行 quick_validate.py；核对模板和引用；独立检查最终文件。
- [x] 请求在 Codex 中打开 SKILL.md；交付文件链接与调用名称。

## 执行记录

- 用户已经授权开始编写；内联执行，无需新增批准环节。
- 当前目录不是 Git 仓库；直接创建个人 skill，不创建 worktree 或提交。
- Task 1: complete。包结构校验通过；五次独立关键决策模拟及需求确认、回退、完整文档整理三项模拟通过；独立审阅无阻塞问题。
- 验证记录与模拟原始回复保留在 /tmp/technical-design-skill.JgJ1Jz/，不包含在交付 skill 中。
- 默认 Python 缺少 PyYAML，使用现有缓存模块运行校验，无新安装或依赖改动。
