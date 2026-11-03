# Model

保存模型消息、内容块和结束原因的共同类型，并根据本地凭据给出可用模型。公开入口为 `@agent-learning/model`，网页通过 `import type` 使用共享类型，不将后端凭据代码打入网页。

`discoverModels(credentials?)` 组合内置目录与 Credentials 的本地检查结果，返回 `ModelDiscovery`：`models` 是可用的 `ModelInfo[]`，`deepseek` 是非敏感凭据状态。默认使用 `~/.agent-learning/auth.json`；可信后端和测试可注入只有 `readStatus()` 的凭据对象。

本阶段只支持 `deepseek-flash`，提供方为 `deepseek`，协议目录标识为 `openai-completions`。凭据为 `configured` 时返回模型，缺失或错误时返回空目录及对应状态。每次发现读取当前状态，不缓存旧模型，不发网络请求，也不验证远端 Key。

Pi 将支持目录、可用性和实际请求认证分开；本包沿用这条职责划分。实际调用留待阶段三，本包不保存对话历史。

在仓库根目录安装 workspace 依赖后：

```sh
npm --prefix packages/credentials run build
npm --prefix packages/model run build
npm --prefix packages/model test
```

测试在临时路径保存、替换和删除假 Key，检查模型发现与错误状态，不访问用户配置或服务商。
