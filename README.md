# dsh-pwsh-encoding-fix

修复 DeepSeek Harness（DSH）pwsh 工具中文/非 ASCII 输出乱码的正式插件（bundle 型）。

## 问题根因

DSH 的 pwsh 执行器（`@deepseek-ai/dsh-pwsh-local`）会为每条命令前置
`[Console]::OutputEncoding = UTF8`，且 Node 侧收集器只按 UTF-8 解码管道。
中文 Windows 上原生程序（`ipconfig`、`systeminfo`、`chcp` 等）输出的是
OEM/ANSI 代码页字节（本机即 GBK/936）；这些字节被 pwsh 按 UTF-8 解码时，
非法序列会被替换成 **U+FFFD（有损）**——信息在 pwsh 内部就已丢失，
事后任何"再解码"都无法还原，所以必须在 pwsh 进程内修复。

## 修复方式

包装 `ctx.shell.resolve`（前台 `run` 与后台 `start` 统一经过的咽喉点），把每条
pwsh 命令包进一个单行包装器：

1. 先把 `[Console]::OutputEncoding` 切到**系统 ANSI 代码页**（`[Text.Encoding]::Default`，本机即 GBK，换机器自动适配）；
2. 在脚本块内执行原命令，并在紧接其后捕获 `$?` 与 `$LASTEXITCODE`；
3. `finally` 恢复 UTF-8 后再输出收集到的文本（`Out-String`），管道最终以 UTF-8 输出，Node 侧即可正确解码；
4. 命令失败时按捕获的退出码 `exit`，保持原工具的退出码语义。

只对 PowerShell executor 生效（运行时检测 `shell.pwshPath`），bash 不受影响；
沙箱 executor（pwsh-sandbox）的 resolve 逻辑被保留（包装而非替换）。

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add "github:hongweifei/dsh-pwsh-encoding-fix"

# 本地源码测试（<绝对路径> 换成插件源码所在目录）
dsh plugin --profile web add "<绝对路径>"

# 重启 dsh web 并硬刷新浏览器（Ctrl+F5）
```

包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它并入该 profile 的
`dsh.profile.bundles`，启动时作为 bundle 补丁层自动激活，无需手改配置。

### 手动安装（github 不可达 / pnpm 解析其他 git 依赖失败时）

```powershell
# 1. 把插件源码目录链接进 profile 的 node_modules（<插件源码绝对路径> 换成实际路径）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-external\dsh-pwsh-encoding-fix" -Target "<插件源码绝对路径>"

# 2. 在 profiles\web\package.json 中补两处：
#    dependencies 加   "@dsh-external/dsh-pwsh-encoding-fix": "file:<插件源码绝对路径>"
#    dsh.profile.bundles 加 "@dsh-external/dsh-pwsh-encoding-fix"
```

> 说明：`dsh plugin add` 会重解析 profile 的全部依赖；若其他依赖是 git 源且
> 当前网络无法访问，pnpm 会整体失败。手动方式绕过 pnpm，运行时加载器只读
> `node_modules` 与 `dsh.profile.bundles`。网络恢复后建议再跑一次
> `dsh plugin --profile web install`（或 `pnpm install`）以同步锁文件。

## 可选配置

如需显式指定原生输出的 ANSI 代码页（默认 `Default` = 系统 ANSI 代码页），
可在 profile 的 `cordis.patch.yml` 中给该行追加配置：

```yaml
- insert:
    - id: pwsh-encoding-fix
      name: '@dsh-external/dsh-pwsh-encoding-fix'
      config:
        codePage: '936'
```

## 已知边界

- 命令以 `exit N` 结尾：包装分支下输出先被收集、`exit` 直接终止进程，该次输出会丢失（退出码仍正确）——罕见场景。
- 超大输出会在 pwsh 内存中先聚合（`Out-String`）；管道的字节截断/溢出落盘机制不受影响。

## License

MIT
