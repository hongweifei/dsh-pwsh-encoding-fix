/**
 * pwsh-encoding-fix — @dsh-external/dsh-pwsh-encoding-fix
 *
 * Fix garbled non-ASCII output from the pwsh tool on Windows.
 *
 * Root cause: the pwsh executor (`@deepseek-ai/dsh-pwsh-local`) prepends
 * `[Console]::OutputEncoding = UTF8` to every command and the Node-side
 * collector decodes the pipe as UTF-8 only. Native Windows tools (ipconfig,
 * systeminfo, chcp, …) write OEM/ANSI-codepage bytes (e.g. GBK/936 on Chinese
 * systems); pwsh then decodes those bytes as UTF-8, which is lossy — invalid
 * sequences become U+FFFD before the text ever reaches us, so a result-level
 * re-decode can never recover them.
 *
 * Fix: wrap every pwsh command so the native output is decoded inside pwsh
 * with the system ANSI codepage, collected as .NET strings, then re-emitted
 * as UTF-8 once the pipe encoding is restored. Exit-code semantics are
 * preserved: `$?` / `$LASTEXITCODE` are captured right after the original
 * command and replayed via a final `exit` only when the command failed.
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
 * Build the single-line PowerShell wrapper around one command.
 *
 * The wrapper must stay ONE line with `try{}finally{}` adjacent (a `;`
 * between them is a PowerShell parse error). Inside the script block the
 * original command runs first, then `$?` and `$LASTEXITCODE` are captured
 * into script scope before anything else can disturb them.
 *
 * @param command - the original PowerShell command text.
 * @param encodingExpr - the `[Text.Encoding]` expression used for native decode.
 * @returns the wrapped command string handed to the executor.
 */
function wrapCommand(command, encodingExpr) {
	return (
		'$__dsh_prev=[Console]::OutputEncoding;[Console]::OutputEncoding=' + encodingExpr + ';' +
		'try{$__dsh_out=&{ ' + command + '; $script:__dsh_q=$?;$script:__dsh_lx=$LASTEXITCODE } 2>&1|Out-String}' +
		'finally{[Console]::OutputEncoding=$__dsh_prev};' +
		'$__dsh_out;' +
		'if(-not $script:__dsh_q){if($script:__dsh_lx -lt 0){$script:__dsh_lx=1};exit $script:__dsh_lx}'
	)
}

/**
 * Apply the fix. Optional config:
 *   - `codePage`: an explicit ANSI code page for native output, e.g. `"936"`.
 *     Omit it (or use `"Default"`) to decode with the system ANSI codepage.
 */
export function apply(ctx, config = {}) {
	// Only meaningful for a PowerShell executor (pwsh-local / pwsh-sandbox).
	// A bash executor has no `pwshPath` capability and must be left untouched.
	if (typeof ctx.shell.pwshPath !== 'string') return
	const originalResolve = ctx.shell.resolve
	if (typeof originalResolve !== 'function') return

	const raw = config?.codePage
	const encodingExpr =
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
				command: wrapCommand(request.command, encodingExpr),
			}))
		}
		return originalResolve.call(this, request)
	}

	// Restore the original resolve when the plugin is stopped or updated.
	ctx.effect(() => () => {
		ctx.shell.resolve = originalResolve
	}, 'pwsh-encoding-fix: restore shell.resolve')
}
