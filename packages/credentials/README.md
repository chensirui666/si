# 网页签名文件

本阶段只管理网页授权的签名密钥，不读取模型 Key。阅读顺序：本文件 → `src/index.ts` → `src/credentials.ts` → `src/credential-file.ts` → `test/credentials.test.ts`。

公开入口 `loadOrCreateBrowserSecret(filename?: string): Promise<Buffer>` 默认使用 `~/.agent-learning/browser-auth.json`，返回 32 字节密钥；可选文件路径只供临时目录测试隔离，网页不能传入路径。`BrowserAuthFile` 是 `{version: 1, secret: string}`，secret 使用规范、无填充的 base64url。

首次创建使用目录 `0700`、文件 `0600`、跨进程独占锁、锁内重读、同目录随机独占临时文件与原子替换。已有文件直接校验读取，不更新文件时间；宽权限、不可读、坏 JSON/版本/密钥、符号链接和非普通文件都拒绝，不静默修复或换密钥。错误不包含密钥、文件正文或底层异常。

锁等待最多 2 秒，只释放本次获得的锁。异常退出可能留下 `browser-auth.json.lock`；本实现不会猜测锁是否失效并删除它。遇到锁超时，先停止所有使用该文件的后端，核实锁中 PID 已退出，再移走残留锁后重新启动；服务仍在运行时移走锁会破坏并发保护。坏签名文件需要人工修复或移走；移走签名文件后生成新密钥会使旧 Cookie 失效。

采用 dsh 的独占创建、锁内重读和同目录替换思路，按已批准范围省略死进程锁自动接管、Windows 权限兼容和断电持久性保证。不能阻止同账号程序或管理员访问密钥。

在仓库根安装 workspace 依赖后：

```sh
npm --prefix packages/credentials run build
npm --prefix packages/credentials test
```

测试只使用临时目录，包括真实 Node 子进程并发，不访问默认签名文件。
