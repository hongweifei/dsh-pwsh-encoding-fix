/**
 * pwsh-encoding-fix — @dsh-external/dsh-pwsh-encoding-fix
 *
 * Fix garbled non-ASCII output from the pwsh tool on Windows.
 *
 * Root cause: the pwsh executor (`@deepseek-ai/dsh-pwsh-local`) prepends
 * `[Console]::OutputEncoding = UTF8` to every command and the Node-side
 * collector decodes the pipe as UTF-8 only. Native Windows tools do NOT agree
 * on an output encoding, so any single decode codepage is wrong for half of
 * them:
 *
 *   - classic native tools (ipconfig, systeminfo, chcp, Java 8-17 on a
 *     Chinese system, …) write ANSI/OEM-codepage bytes (GBK/936 here);
 *   - modern tools (node, git, Maven 3.9+, Java 18+ with
 *     `stdout.encoding=UTF-8`, anything honoring `chcp 65001`, …) write UTF-8.
 *
 * A wrapper that picks ONE decode codepage (as v1 did: system ANSI) fixes the
 * first group but mangles the second — which is exactly the class of bug this
 * version addresses (UTF-8 bytes decoded as GBK, e.g. `错误` → `閿欒`).
 *
 * Fix: capture the native output as raw bytes by decoding with Latin-1
 * (codepage 28591, byte-preserving — one byte → one char, never lossy), then
 * recover the original byte stream inside pwsh and decode each contiguous
 * byte-run heuristically: strict UTF-8 if valid, otherwise the system ANSI
 * codepage (configurable via `codePage`). Text that PowerShell itself emitted
 * (real Unicode chars > U+00FF) never entered the native decode path and is
 * passed through untouched, so mixed output (native tool + `Write-Output`)
 * stays correct on every segment. The final text is re-emitted as UTF-8 once
 * the pipe encoding is restored; exit-code semantics are preserved
 * (`$?` / `$LASTEXITCODE` are captured right after the original command and
 * replayed via a final `exit` only when the command failed).
 *
 * The wrapper is applied at `ctx.shell.resolve`, the single choke point that
 * both foreground (`run`) and background (`start`) executions go through, and
 * only when the mounted executor is a PowerShell one (checked via the
 * `pwshPath` capability). The sandbox executor's own resolve logic is left
 * intact (we wrap it, never replace it).
 */

export const name = 'pwsh-encoding-fix'

/** The shell service is a hard dependency: the plugin exists only to wrap it. */
export const inject = ['shell']

/**
 * Latin-1 (ISO-8859-1, codepage 28591): the byte-preserving capture encoding.
 * Every byte 0x00-0xFF maps to exactly one char and back, so native output can
 * be re-encoded into its original bytes no matter what codepage the tool
 * actually wrote in.
 */
const BYTE_PRESERVING_CP = 28591

/**
 * Build the single-line PowerShell wrapper around one command.
 *
 * The wrapper must stay ONE line (the executor prepends its UTF-8 preamble on
 * line 1 and error positions reference the -Command text) and `try{}finally{}`
 * must stay adjacent (a `;` between them is a PowerShell parse error). Inside
 * the script block the original command runs first, then `$?` and
 * `$LASTEXITCODE` are captured into script scope before anything else can
 * disturb them.
 *
 * Pipeline shape:
 *   1. `[Console]::OutputEncoding` → Latin-1 so native output is captured
 *      byte-by-byte (lossless for every byte value, unlike UTF-8/GBK which
 *      replace or mis-pair on foreign byte streams).
 *   2. `& { <command>; $?; $LASTEXITCODE } 2>&1 | Out-String -Width big`
 *      collects native stdout/stderr (as Latin-1 chars) and pwsh's own text
 *      (as real Unicode chars) into one string. `Out-String` keeps pwsh's
 *      object table formatting; a huge `-Width` prevents line wrapping.
 *   3. `__dshx_fix` splits the captured string into maximal runs of
 *      byte-range chars (≤ U+00FF — native bytes) and non-byte-range chars
 *      (pwsh's own text), re-encodes byte-runs into the original bytes and
 *      decodes each run: strict UTF-8 when valid, else the configured ANSI
 *      codepage. pwsh's own text runs are used as-is.
 *   4. The recovered text is emitted after `[Console]::OutputEncoding` is
 *      restored, so the pipe carries it as UTF-8.
 *
 * @param command - the original PowerShell command text.
 * @param ansiEncodingExpr - the `[Text.Encoding]` expression used to decode
 *        byte runs that are not valid UTF-8 (system ANSI codepage by default).
 * @returns the wrapped command string handed to the executor.
 */
function wrapCommand(command, ansiEncodingExpr) {
	return (
		`$__dshx_ansi=${ansiEncodingExpr};$__dshx_p=[Console]::OutputEncoding;` +
		`function __dshx_fix($__dshx_s){` +
		`$__dshx_l=[Text.Encoding]::GetEncoding(${BYTE_PRESERVING_CP});` +
		`$__dshx_u=New-Object System.Text.UTF8Encoding($false,$true);` +
		`$__dshx_a=New-Object 'System.Collections.Generic.List[string]';` +
		`foreach($__dshx_m in [regex]::Matches($__dshx_s,'[\\x00-\\xFF]+|[^\\x00-\\xFF]+')){` +
		`if([int]$__dshx_m.Value[0] -le 255){` +
		`$__dshx_by=$__dshx_l.GetBytes($__dshx_m.Value);` +
		`try{$__dshx_a.Add($__dshx_u.GetString($__dshx_by))}catch{$__dshx_a.Add($__dshx_ansi.GetString($__dshx_by))}` +
		`}else{$__dshx_a.Add($__dshx_m.Value)}` +
		`};` +
		`$__dshx_r=($__dshx_a -join '');$__dshx_r};` +
		`[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(${BYTE_PRESERVING_CP});` +
		`try{$__dshx_o=&{ ${command}; $script:__dshx_q=$?;$script:__dshx_lx=$LASTEXITCODE } 2>&1|Out-String -Width 2147483647}` +
		`finally{[Console]::OutputEncoding=$__dshx_p};` +
		`$__dshx_o=__dshx_fix $__dshx_o;$__dshx_o;` +
		`if(-not $script:__dshx_q){if($script:__dshx_lx -lt 0){$script:__dshx_lx=1};exit $script:__dshx_lx}`
	)
}

/**
 * Apply the fix. Optional config:
 *   - `codePage`: an explicit ANSI code page used to decode native output that
 *     is not valid UTF-8, e.g. `"936"`. Omit it (or use `"Default"`) to use
 *     the system ANSI codepage.
 */
export function apply(ctx, config = {}) {
	// Only meaningful for a PowerShell executor (pwsh-local / pwsh-sandbox).
	// A bash executor has no `pwshPath` capability and must be left untouched.
	if (typeof ctx.shell.pwshPath !== 'string') return
	const originalResolve = ctx.shell.resolve
	if (typeof originalResolve !== 'function') return

	const raw = config?.codePage
	const ansiEncodingExpr =
		raw !== void 0 && raw !== null && String(raw).trim() !== '' && String(raw).trim() !== 'Default'
			? '[Text.Encoding]::GetEncoding(' + JSON.stringify(String(raw).trim()) + ')'
			: '[Text.Encoding]::Default'

	ctx.shell.resolve = function (request) {
		if (
			request !== null &&
			typeof request === 'object' &&
			typeof request.command === 'string' &&
			request.command.trim().length > 0
		) {
			return originalResolve.call(this, Object.assign({}, request, {
				command: wrapCommand(request.command, ansiEncodingExpr),
			}))
		}
		return originalResolve.call(this, request)
	}

	// Restore the original resolve when the plugin is stopped or updated.
	ctx.effect(() => () => {
		ctx.shell.resolve = originalResolve
	}, 'pwsh-encoding-fix: restore shell.resolve')
}
