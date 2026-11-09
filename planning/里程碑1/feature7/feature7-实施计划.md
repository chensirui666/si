# Feature7 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development; independent file scopes are delegated.

**Goal:** 完成现有 Feature7 技术设计及其验收。
**Architecture:** Agent 保留原始消息，压缩模块投影摘要与近期原文；Model 负责单次请求及统一估算；Server/网页同步明确运行状态。
**Tech Stack:** 现有 TypeScript、Node、React、Lexical、Vitest、Playwright，无新增依赖。
**Spec:** [Feature7 技术设计](../../../docs/里程碑1/feature7/feature7-基础上下文压缩技术设计.md)

## Global Constraints

- 核心参考 Pi，容量显示参考 dsh；正常 systemPrompt 与工具不变。
- 正式近期预算 20,000、输出 65,536、额外余量 16,384；测试预算只进程内装配。
- 工具结果摘要前 1,500 / 后 500 完整字符；失败/中止不提交候选。
- 原始历史保留内存，持久化留 Feature10；不读取未指定凭据。

## Review Focus

- 工具成组切分及失败助手关联结果过滤。
- 压缩后容量显示可校准，但门禁必须失效旧实际样本。
- 摘要中止等待流清理、取消前不能提交。
- 大快照后连续更新与慢连接保护。
- 命令菜单的输入法、焦点、撤销和接收竞态。

### Task 1: Model 与压缩准备
- [x] 先补失败测试，落实估算、序列化、容量与错误分类。
- [x] 单元验证完整组成、工具配对、Unicode 截断与重复摘要。
- [x] Run: Model/Compaction Vitest，预期全部通过。

### Task 2: Agent 与 HTTP/WS
- [x] 先补失败测试，落实分类提交、runId、中止、手动/自动/超限一次恢复。
- [x] 保护原始历史和 systemPrompt，关联真实用量并区分容量门禁/显示。
- [x] Run: Agent/Server Vitest，预期全部通过。

### Task 3: 网页与输入
- [x] 先补失败测试，同步契约与夹具，再实现圆环、记录和 Lexical 命令补全。
- [x] Run: 网页单元及真实 Chromium 组件测试，预期全部通过。

### Task 4: 完整验收与独立审查
- [x] 实现真实同会话两次压缩 E2E，真实凭据仅由用户指定文件提供。
- [x] Run: npm test、真实工具验收（凭据具备时），预期全部通过，跳过项明确记录。
- [x] 独立审查，修复实际发现的问题并复验。
- [x] 更新 README 与 68 case 证据表，不把跳过算通过。

实施阶段的历史执行结果与边界见[验收记录](../../../docs/里程碑1/feature7/feature7-验收记录.md)。根测试 501 项通过、0 失败和跳过；独立真实工具 7 项通过；合计 508 项通过，0 失败和跳过。该统计来自实施阶段，不代表本次文档归位或合并后的复验；当前合并状态另行核对。
