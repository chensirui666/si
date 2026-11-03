# Model

保存模型消息、内容块和结束原因的共同类型，由公开入口 `@agent-learning/model` 导出。
网页和其他包通过 `import type` 使用这些类型。

阶段一只有类型，没有模型发现、网络请求或生成函数。后续实现一次模型调用时仍不在这里保存对话历史。

在仓库根目录安装 workspace 依赖后，运行 `npm --prefix packages/model run build` 检查类型并输出 `dist/`。
