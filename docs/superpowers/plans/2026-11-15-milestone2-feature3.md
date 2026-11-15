# Milestone 2 Feature 3 Implementation Plan

**Goal**　让用户在实际聊天里发现、使用、创建和更新 Skill。
**Architecture**　Coding Agent 共用一套磁盘发现规则。会话保存显式加载快照并复用历史转换。HTTP 查询返回摘要，WebSocket 推送加载状态，网页复用输入框的命令菜单。
**Tech Stack**　TypeScript、Node.js、YAML、React、Lexical、Vitest、Playwright。
**Spec**　[已通过技术设计](../../../planning/里程碑2/feature3/feature3-Skill技术设计.md) · [33 项验收](../../../planning/里程碑2/feature3/feature3-Skill验收标准.md)

1. 在 Coding Agent 增加 discoverSkills、loadSkill 和发现测试。覆盖目录优先级、递归停止、符号链接、非法文件及局部失败。复用有限大小的普通文件读取方式。
2. 在 AgentSession 中处理显式指定，文件读取完成后重新检查提交状态。通过 compaction.ts 的同一消息转换验证首次输入、重试、历史与压缩。用现有 read 和执行权限机制覆盖自动使用。
3. 增加工作区 Skill 查询，在现有 WebSocket 投影中移除正文与资源路径。验证首发前可查询，以及已接收和重连看到一致的加载状态。
4. MessageInput 复用已有命令菜单，按工作区和菜单打开时机请求 Skill。验证过期响应、鼠标、Tab、组合输入、分组与失败反馈。MessageList 显示加载结果。
5. 添加应用 Skill 规则及三份资源。验证正式 Chromium 入口从查看和加载到文件效果，使用显式提供的测试凭据运行真实模型用例。执行根 npm test，记录实际覆盖与待验证项。
