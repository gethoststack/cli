import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, cyan, dim, handleError, red, yellow } from '../lib/output.ts';

interface LogEntry {
	timestamp: string;
	level?: string;
	message: string;
}

export async function logsCommand(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(
			`${bold('Usage:')} hoststack logs <service-id> [--lines <n>] [--since <duration>]`,
		);
		console.log();
		console.log('Options:');
		console.log('  --lines <n>          Number of log lines (default: 100)');
		console.log('  --since <duration>   Duration like 1h, 30m, 1d (default: 1h)');
		process.exit(1);
	}

	const linesIdx = args.indexOf('--lines');
	const lines = linesIdx !== -1 ? args[linesIdx + 1] : undefined;
	const sinceIdx = args.indexOf('--since');
	const since = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;

	try {
		const params = new URLSearchParams();
		if (lines) params.set('lines', lines);
		if (since) params.set('since', since);

		const qs = params.toString();
		const path = `/api/services/${teamId}/${serviceId}/runtime-logs${qs ? `?${qs}` : ''}`;
		const data = await apiFetch<{ logs: LogEntry[] | string }>(path);

		if (typeof data.logs === 'string') {
			console.log(data.logs);
			return;
		}

		const logEntries = data.logs;
		if (!logEntries || logEntries.length === 0) {
			console.log(dim('No logs found.'));
			return;
		}

		for (const entry of logEntries) {
			const ts = dim(new Date(entry.timestamp).toISOString());
			const level = formatLevel(entry.level);
			console.log(`${ts} ${level} ${entry.message}`);
		}
	} catch (err) {
		handleError(err);
	}
}

function formatLevel(level?: string): string {
	switch (level?.toLowerCase()) {
		case 'error':
		case 'err':
			return red('ERR');
		case 'warn':
		case 'warning':
			return yellow('WRN');
		case 'info':
			return cyan('INF');
		case 'debug':
			return dim('DBG');
		default:
			return dim('LOG');
	}
}
