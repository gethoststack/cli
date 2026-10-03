// --- Color & TTY detection ---
//
// Suppress ANSI escapes when:
//   - the user set NO_COLOR (https://no-color.org)
//   - the user set FORCE_COLOR=0
//   - stdout is not a TTY (piped to a file or CI log capture)
// Force enable when FORCE_COLOR=1 or FORCE_COLOR=true.
//
// Evaluated per-call (cheap) so tests / scripts can override the env late
// and the next call respects it.
function colorEnabled(): boolean {
	const force = process.env.FORCE_COLOR;
	if (force === '0' || force === 'false') return false;
	if (force === '1' || force === 'true') return true;
	if (process.env.NO_COLOR) return false;
	if (process.env.NODE_DISABLE_COLORS) return false;
	// Suppress color when stdout is not a TTY (piped to a file, captured by CI,
	// or consumed by another program) unless color was force-enabled above.
	// Emitting raw ANSI into a pipe corrupts `| grep`, `> file`, and `--json`
	// consumers. A real terminal (isTTY === true) keeps color on by default.
	if (process.stdout.isTTY !== true && force === undefined) {
		return false;
	}
	return true;
}

function wrap(open: string, close: string): (s: string) => string {
	return (s: string) => (colorEnabled() ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

// --- ANSI color helpers ---
export const bold = wrap('1', '0');
export const dim = wrap('2', '0');
export const green = wrap('32', '0');
export const red = wrap('31', '0');
export const yellow = wrap('33', '0');
export const cyan = wrap('36', '0');

// --- Table formatter ---
export function table(headers: string[], rows: string[][]): string {
	const allRows = [headers, ...rows];
	const colWidths = headers.map((_, colIdx) =>
		Math.max(...allRows.map((row) => (row[colIdx] ?? '').length)),
	);

	const separator = colWidths.map((w) => '-'.repeat(w + 2)).join('+');
	const formatRow = (row: string[]) =>
		row.map((cell, i) => ` ${(cell ?? '').padEnd(colWidths[i]!)} `).join('|');

	const lines: string[] = [];
	lines.push(formatRow(headers.map((h) => bold(h))));
	lines.push(separator);
	for (const row of rows) {
		lines.push(formatRow(row));
	}
	return lines.join('\n');
}

// --- Status badge ---
export function statusBadge(status: string): string {
	switch (status) {
		case 'running':
		case 'active':
		case 'deployed':
		case 'success':
			return green(status);
		case 'failed':
		case 'error':
		case 'suspended':
			return red(status);
		case 'building':
		case 'deploying':
		case 'pending':
			return yellow(status);
		case 'cancelled':
		case 'stopped':
			return dim(status);
		default:
			return status;
	}
}

// --- Spinner ---
// Animates only when stdout is a TTY. Non-interactive callers (CI, scripts)
// get a single-line "Running…" → "Done" pair, keeping piped logs clean.
export function spinner(message: string): { stop: (finalMessage?: string) => void } {
	if (!process.stdout.isTTY) {
		process.stdout.write(`${message}\n`);
		return {
			stop(finalMessage?: string) {
				if (finalMessage) process.stdout.write(`${finalMessage}\n`);
			},
		};
	}

	const frames = ['|', '/', '-', '\\'];
	let i = 0;

	const interval = setInterval(() => {
		process.stdout.write(`\r${cyan(frames[i % frames.length]!)} ${message}`);
		i++;
	}, 100);

	return {
		stop(finalMessage?: string) {
			clearInterval(interval);
			// Clear the line then write the final state. CSI 2K erases the entire
			// spinner row so a shorter final message doesn't leave trailing frames.
			process.stdout.write(`\r\x1b[2K${green('+')} ${finalMessage ?? message}\n`);
		},
	};
}

// --- Error handler ---
export function handleError(err: unknown): never {
	if (err instanceof Error) {
		console.error(`${red('Error:')} ${err.message}`);
	} else {
		console.error(`${red('Error:')} ${describeThrown(err)}`);
	}
	process.exit(1);
}

/** A thrown non-Error as text: its own message when it has one, never `[object Object]`. */
function describeThrown(err: unknown): string {
	if (typeof err === 'string') return err;
	if (typeof err === 'object' && err !== null) {
		const message =
			(err as { message?: unknown; error?: unknown }).message ??
			(err as { error?: unknown }).error;
		if (typeof message === 'string') return message;
		try {
			return JSON.stringify(err);
		} catch {
			return 'Unknown error';
		}
	}
	return String(err);
}
