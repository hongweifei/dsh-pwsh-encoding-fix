# dsh-pwsh-encoding-fix

一个用于 **DeepSeek Harness（DSH）** 的 Cordis 插件（bundle 型），修复 DSH 的
pwsh 工具在 Windows 上执行命令时，中文及其他非 ASCII 输出变成乱码的问题。

## 简介

DSH 的 pwsh 工具会在 Windows 上执行 PowerShell 命令，并把命令的 stdout/stderr
回传给你。在中文 Windows 上，原生程序的输出编码并不统一：

- 有的程序按 **系统 ANSI 代码页**输出（中文系统即 GBK/936，如 `ipconfig`、
  `systeminfo`、`chcp`、直接调用的 javac 等）；
- 有的程序按 **UTF-8** 输出（`node`、`git`、Maven 3.9+、Gradle 9 的编译诊断、
  Java 18+ 等）。

而 DSH 内部只按 UTF-8 解码输出，于是**任何单一解码方式都会让其中一类程序
变成乱码**：GBK 输出按 UTF-8 解码会得到 `锟斤拷` 一类的替换字符，UTF-8 输出
按 GBK 解码会得到 `閿欒` 一类的错字（`错误` → `閿欒`）。

本插件在 PowerShell 进程内做一次「按字节无损捕获 → 自动识别编码 → 以 UTF-8
重新输出」的转换，让两类程序的输出都能正确显示。

## 特性

- **自动识别编码**：同一命令里 GBK 与 UTF-8 输出混排也能逐段正确处理；
- **无损捕获**：用 Latin-1（代码页 28591）逐字节接收原生输出，不会把非法
  字节序列替换成 U+FFFD，信息不会丢失；
- **不改变命令语义**：`$?` / `$LASTEXITCODE` 照常捕获，命令失败时退出码不变；
- **前台与后台命令都生效**：包装发生在 `shell.resolve`（`run` 与 `start`
  共同经过的入口）；
- **只作用于 PowerShell**：bash 执行器不受影响；沙箱执行器（pwsh-sandbox）
  自身的逻辑被保留（包装而非替换）。

## 工作原理

### 问题背景

DSH 的 pwsh 执行器（`@deepseek-ai/dsh-pwsh-local`）会为每条命令前置
`[Console]::OutputEncoding = UTF8`，Node 侧收集器也只按 UTF-8 解码管道。
以两种典型的程序输出为例：

| 程序输出 | 实际字节 | 按 UTF-8 解码 | 按 GBK 解码 |
| --- | --- | --- | --- |
| `ipconfig`、直接调用的 javac | GBK | U+FFFD 乱码 | 正确 |
| `node`、Maven 3.9+、Gradle 9 | UTF-8 | 正确 | `閿欒` 乱码 |

早期的 v1 版本固定按系统 ANSI 代码页解码，修好了 GBK 一类，却把 UTF-8
一类弄成了新的乱码（`错误` → `閿欒`）。v2 改为逐字节捕获后再自动判断。

### 解决思路

插件包装 `ctx.shell.resolve`，把每条命令包进一个单行 PowerShell 包装器：

1. 先把 `[Console]::OutputEncoding` 切换为 **Latin-1（28591）**。Latin-1
   是逐字节编码——一个字节对应一个字符，无论原生程序实际写的是 GBK 还是
   UTF-8，字节都被无损保留，不会在捕获阶段丢失信息；
2. 在脚本块内执行原命令，并紧接其后捕获 `$?` 与 `$LASTEXITCODE`；
3. 对捕获结果按字符范围切分：
   - **字节段**（连续 `≤ U+00FF` 的字符）：还原成原始字节后做启发式解码——
     先按严格 UTF-8 解码，失败则按系统 ANSI 代码页解码（可用 `codePage`
     配置覆盖）；
   - **文本段**（PowerShell 自己输出的 Unicode 字符）：原样保留；
4. `finally` 中恢复 UTF-8，再把恢复出的文本以 UTF-8 输出，Node 侧即可
   正确解码；
5. 命令失败时按捕获的退出码 `exit`，保持原工具的退出码语义。

### 实现说明

- 包装点在 `ctx.shell.resolve`，前台 `run` 与后台 `start` 都经过这里；
- 仅当执行器是 PowerShell（运行时检测 `shell.pwshPath`）时才生效；
- 包装器保持单行，`try{}finally{}` 必须相邻（中间加 `;` 是 PowerShell
  语法错误）；
- 内部变量统一使用 `__dshx_` 前缀，避免与用户命令的变量冲突。

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add "github:hongweifei/dsh-pwsh-encoding-fix"

# 从本地源码安装（<绝对路径> 换成插件源码所在目录）
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
> `node_modules` 与 `dsh.profile.bundles`。
>
> 注意：若 profile 同时安装了会**自动同步/更新插件**的其他插件（例如
> dsh-plugin-workshop 的自动更新），它可能把以 `github:` 方式安装的插件
> 重新拉取并覆盖本地改动。需要本地版本长期生效时，请使用本地源码
> （`link:`/`file:`）方式安装，或关闭自动更新。

## 配置

如需显式指定「非 UTF-8 字节」的 ANSI 代码页（默认 `Default` = 系统 ANSI
代码页），可在 profile 的 `cordis.patch.yml` 中给该行追加配置：

```yaml
- insert:
    - id: pwsh-encoding-fix
      name: '@dsh-external/dsh-pwsh-encoding-fix'
      config:
        codePage: '936'
```

## 验证

重启 dsh web 后，在 pwsh 工具里执行：

```powershell
# UTF-8 输出的程序：修复前显示 閿欒: 鎵句笉鍒扮鍙?，修复后显示 错误: 找不到符号
node -e "process.stdout.write('\u9519\u8bef: \u627e\u4e0d\u5230\u7b26\u53f7\n')"

# GBK 输出的程序：中文应正常显示
ipconfig
```

## 已知边界

- `Write-Host` 输出走宿主输出流、绕过管道：捕获期间 `[Console]::OutputEncoding`
  是 Latin-1，`Write-Host` 的中文会被按 Latin-1 编码成 `?`。请改用
  `Write-Output` 输出到管道（原生工具输出与 `Write-Output` 混排完全正常）。
- 命令以 `exit N` 结尾：包装分支下输出先被收集、`exit` 直接终止进程，该次
  输出会丢失（退出码仍正确）——罕见场景。
- PowerShell 5.1 向原生程序传参（`$OutputEncoding` 为 UTF-8 时）对含 `.`
  的参数（如 `-Dstdout.encoding=UTF-8`）有 5.1 自带的拆参数问题，与输出编码
  无关；可改用环境变量（如 `$env:JAVA_TOOL_OPTIONS='-Dstdout.encoding=UTF-8'`）。
- 超大输出会在 pwsh 内存中先聚合（`Out-String`）；管道的字节截断/溢出落盘
  机制不受影响。

## License

MIT
