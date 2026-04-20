// --- ANSI color helpers ---
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

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
export function spinner(message: string): { stop: (finalMessage?: string) => void } {
	const frames = ['|', '/', '-', '\\'];
	let i = 0;

	const interval = setInterval(() => {
		process.stdout.write(`\r${cyan(frames[i % frames.length]!)} ${message}`);
		i++;
	}, 100);

	return {
		stop(finalMessage?: string) {
			clearInterval(interval);
			process.stdout.write(`\r${green('+')} ${finalMessage ?? message}\n`);
		},
	};
}

// --- Error handler ---
export function handleError(err: unknown): never {
	if (err instanceof Error) {
		console.error(`${red('Error:')} ${err.message}`);
	} else {
		console.error(`${red('Error:')} ${String(err)}`);
	}
	process.exit(1);
}
