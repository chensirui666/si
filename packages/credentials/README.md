# 本地凭据

管理网页授权签名密钥和 DeepSeek 模型 Key，两者分别存放、分别校验。阅读顺序：本文件 → `src/index.ts` → `src/credentials.ts` → `src/credential-file.ts` → `test/credentials.test.ts`。

网页签名入口 `loadOrCreateBrowserSecret(filename?: string): Promise<Buffer>` 默认使用 `~/.agent-learning/browser-auth.json`，返回 32 字节密钥；可选文件路径只供临时目录测试隔离，网页不能传入路径。`BrowserAuthFile` 是 `{version: 1, secret: string}`，secret 使用规范、无填充的 base64url。

首次创建使用目录 `0700`、文件 `0600`、跨进程独占锁、锁内重读、同目录随机独占临时文件与原子替换。已有文件直接校验读取，不更新文件时间；宽权限、不可读、坏 JSON/版本/密钥、符号链接和非普通文件都拒绝，不静默修复或换密钥。错误不包含密钥、文件正文或底层异常。

锁等待最多 2 秒，只释放本次获得的锁。异常退出可能留下 `browser-auth.json.lock`；本实现不会猜测锁是否失效并删除它。遇到锁超时，先停止所有使用该文件的后端，核实锁中 PID 已退出，再移走残留锁后重新启动；服务仍在运行时移走锁会破坏并发保护。坏签名文件需要人工修复或移走；移走签名文件后生成新密钥会使旧 Cookie 失效。

采用 dsh 的独占创建、锁内重读和同目录替换思路，按已批准范围省略死进程锁自动接管、Windows 权限兼容和断电持久性保证。不能阻止同账号程序或管理员访问密钥。

在仓库根安装 workspace 依赖后：

```sh
npm --prefix packages/credentials run build
npm --prefix packages/credentials test
```

测试只使用临时目录，包括真实 Node 子进程并发，不访问默认签名文件。


## 模型 Key

`new Credentials(filename?: string)` 默认使用 `~/.agent-learning/auth.json`，可选路径仅供可信后端和临时目录测试注入。网页不能提供文件路径。公开实例接口：

- `readStatus()` 返回 `missing`、`configured` 或带脱敏原因的 `error`，不会返回 Key。
- `readApiKey()` 每次重读并校验文件，只向后端提供当前 Key；缺失、损坏或不安全权限时抛错，不回退旧缓存。
- `saveApiKey(key)` 保存或替换 DeepSeek Key，`deleteApiKey()` 仅删除 DeepSeek 条目，均在锁内重读并保留其他顶层条目。
- `watch(onChange)` 使用 chokidar 监听目标文件，返回停止函数。覆盖外部新增、原子替换、删除、损坏、修复及文件/目录权限变化；就绪后补查一次，关闭后不再回调。

文件使用 Pi 的提供方 JSON：`{"deepseek":{"type":"api_key","key":"仅作示例"}}`。Key 仅检查非空且能够用作认证头，不猜测前缀或长度；保存成功只表示本地落盘，不验证服务商账号或 Key 有效性。只有此 JSON 提供模型 Key，不读取环境变量、命令或其他凭据来源。删除后后续读取立即失效。

模型文件复用上述权限、锁与原子替换规则。坏文件保留并报错，不能直接用保存或删除覆盖修复。模型文件错误不会改写网页签名密钥。`AuthFile` 和 `CredentialStatus` 从包入口导出。测试均使用假 Key 和临时目录，不访问真实用户配置。
