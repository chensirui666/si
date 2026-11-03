# Feature2 阶段二实施计划

**Goal:** 在授权网页完成 DeepSeek Key 增改删、本地模型发现和多页面同步，完成阶段二全部自动验收。

**Spec:** [阶段二设计](./feature2-阶段二-凭据配置与本地模型发现.md)及[总体设计](./feature2-单会话流式聊天技术设计.md)。使用者已确认按现有方案继续。

**Architecture:** Credentials 复用现有安全文件读写，Model 根据凭据状态提供本地目录，WebServer 复用授权和 WebSocket，ChatPage 独立维护模型状态。保持 Agent 与聊天发送行为。

## 全局约束

- 只支持 DeepSeek，模型 `deepseek-flash`，不进行远端验证或聊天生成。
- 模型文件默认 `~/.agent-learning/auth.json`，与网页签名文件分离；测试全部注入临时路径。
- 锁内重读并校验、保留非目标条目、原子替换；目录 0700，文件 0600；坏文件保留并报错。
- Key 不回传、不缓存至浏览器、不进入日志或历史；每次后端读取使用当前文件，不回退旧缓存。
- 配置通知不改变 Agent 序号；请求失败、旧响应、重连不使页面误报最新配置。
- 参考 Pi AuthStorage 的提供方 JSON 和锁内更新；文件保护复用现有实现，监听沿总体设计的 chokidar。

## 任务与校验

### 1. Credentials 与 Model

- [x] 先补凭据测试并观察失败，再实现 `Credentials(filename?)` 的 `readStatus/readApiKey/saveApiKey/deleteApiKey/watch`。
- [x] 复用 `credential-file.ts`，统一错误名称；Key 非空且可作为认证头；保留其他顶层配置。
- [x] 先补发现测试，再实现 `discoverModels(credentials?)`，导出 `ModelInfo/ModelDiscovery`。
- [x] 校验权限、坏文件、写入失败、跨进程并发、删除后无旧 Key、外部变化及零远端请求。

### 2. 设置界面与客户端

- [x] 先补设置、模型状态及通知测试，再实现 HTTP 客户端与设置弹窗。
- [x] `Subscribe` 增加可选 `onModelsChanged` 回调；`models_changed` 独立于对话更新处理。
- [x] 首次加载、恢复连接和配置通知重新查询，旧查询不得覆盖新结果。
- [x] 添加侧栏底部设置、模型列表和配置错误，Key 保存成功或关闭后清空，发送继续禁用。
- [x] 复用 Button，采用 Radix Dialog；验证 Escape、焦点约束和关闭后焦点返回。

### 3. 服务接入与整体校验

- [x] 先补 HTTP 授权、输入校验与多连接通知测试，再实现三个配置 HTTP 接口。
- [x] `WebServerOptions.modelAuthPath` 仅供可信后端注入；绑定 Credentials 监听，服务关闭时释放。
- [x] 复用 Host/Origin/Cookie 边界；限制 JSON 请求体，错误脱敏，成功后通知连接。
- [x] 根测试命令加入 Model；更新 E2E fixture 注入临时模型文件。
- [x] Node 与 Vite 实际入口均验证保存、替换、多页面同步、重启读取、删除与坏文件可打开设置。
- [x] 跑完整 `npm test`、构建和差异检查，独立审查后修复问题，更新 README 与阶段二验收记录。

## 重点复核

- 损坏或宽权限文件不能被保存操作静默覆盖。
- 同时 GET 与保存/删除不能使页面回到旧模型状态。
- 文件新增、原子替换、删除、权限变化都可同步；停止服务释放监听。
- HTTP 正文、异常和日志不能包含 Key；未授权写入不触碰模型文件。
- 草稿、输入法、焦点、阅读位置及阶段一两种入口保持通过。

## 执行记录

- 基线：从主目录 HEAD `e14df7a` 创建隔离 worktree，分支 `codex/feature2-stage2`。
- 方案确认：使用者选择“按文档方案继续”。
- 只读源码核对：Pi 使用提供方 JSON 和锁内重读；本项目按既定文档拒绝读取失败后沿用旧缓存，继续复用现有原子替换保护。
- 独立审查修复：初始模型查询未返回时保存失败会丢弃查询结果并永久等待；删除保存开始时多余的失效回调，回归先红后绿。
- 基线失败修复：Playwright 直接 DOM 全选后立刻清空与 Lexical 选区同步竞争；改用真实全选和删除键，保留清空、缩回高度、阅读位置断言，重复五次通过。
- 文件监听实测修复：最近已有祖先监听防首次创建遗漏，原始元数据补查防 chokidar 忽略读取后的 chmod；覆盖文件与父目录权限。
- 最终复验：干净 npm ci 后，完整 npm test 161/161；npm audit 0 漏洞，git diff --check 通过；独立审查无未解决 P1/P2。详见验收记录。
- 主干集成：按使用者指令提交 `6079546`，快进合并 main；主目录重新 npm ci、npm test 161/161、npm audit 0 漏洞、git diff --check 全部通过。
- 清理待完成：日志和截图已迁至主目录；原 worktree 当前是聊天主工作目录，Codex 归档工具拒绝移除，保留干净 checkout 与已合并分支，待聊天切回主目录后清理。
