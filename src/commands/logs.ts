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
			`${bold('Usage:')} hoststack logs <service-id> [--lines <n>] [--since <duration>] [--level <level>] [--stream <stream>] [--search <text>]`,
		);
		console.log();
		console.log('Options:');
		console.log('  --lines <n>          Number of log lines (default: 100)');
		console.log('  --since <duration>   Duration like 10m, 1h, 1d, or an ISO-8601 timestamp');
		console.log(`  --level <level>      ${LEVELS.join(' | ')} (structured JSON logs filter on`);
		console.log('                       their own level; plain text maps to a stream)');
		console.log('  --stream <stream>    stdout | stderr');
		console.log('  --search <text>      Case-insensitive substring filter');
		process.exit(1);
	}

	const flag = (name: string): string | undefined => {
		const idx = args.indexOf(name);
		return idx !== -1 ? args[idx + 1] : undefined;
	};
	const lines = flag('--lines');
	const sinceRaw = flag('--since');
	const level = flag('--level');
	const stream = flag('--stream');
	const search = flag('--search');

	// The API reads a relative `since` as `-10m` and silently skips anything it
	// cannot parse, so the `10m` this command has always documented applied no
	// time filter at all — `--since 10m` returned lines from before the window.
	// Translate the documented form, and refuse what neither side understands
	// rather than quietly fetching the unfiltered tail.
	const since = sinceRaw === undefined ? undefined : normalizeSince(sinceRaw);
	if (sinceRaw !== undefined && since === undefined) {
		console.error(
			red(
				`Invalid --since "${sinceRaw}": use a duration like 30s, 10m, 1h, 2d or an ISO-8601 timestamp`,
			),
		);
		process.exit(1);
	}
	// `--level` used to be ignored outright, so `--level error` printed every
	// line. Reject a value the API would 400 on, here, with the list.
	if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
		console.error(red(`Invalid --level "${level}": one of ${LEVELS.join(', ')}`));
		process.exit(1);
	}
	if (stream !== undefined && stream !== 'stdout' && stream !== 'stderr') {
		console.error(red(`Invalid --stream "${stream}": stdout or stderr`));
		process.exit(1);
	}

	try {
		const params = new URLSearchParams();
		if (lines) params.set('lines', lines);
		if (since) params.set('since', since);
		if (level) params.set('level', level);
		if (stream) params.set('stream', stream);
		if (search) params.set('search', search);

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

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'stdout', 'stderr'] as const;

/** `10m` → `-10m`; `-10m` and ISO-8601 pass through; anything else → undefined. */
export function normalizeSince(raw: string): string | undefined {
	const v = raw.trim();
	if (/^\d+[smhd]$/.test(v)) return `-${v}`;
	if (/^-\d+[smhd]$/.test(v)) return v;
	if (/^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return v;
	return undefined;
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
