import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDateTime } from '../lib/format.ts';
import { bold, dim, handleError, red, table, yellow } from '../lib/output.ts';

/**
 * The team audit log: who did what, when.
 *
 * "What changed, and who did it" is a terminal question — it is asked in the
 * minutes after something started behaving differently, usually by the person
 * already in a shell reading logs. It was dashboard-or-MCP only.
 *
 * The feed hides dev-environment lifecycle churn from the team-wide view
 * server-side, so a box waking every morning does not bury the env var
 * somebody deleted. Passing `--resource <id>` turns that filter off for the
 * one resource you named, which is how you get a dev box's own timeline.
 */

interface ActivityEntry {
	id: number;
	action: string;
	severity: string;
	resourceType: string | null;
	resourceId: number | null;
	metadata: unknown;
	ipAddress: string | null;
	userId: number | null;
	userName: string | null;
	userEmail: string | null;
	createdAt: string;
	resolvedAt: string | null;
}

interface ActivityResponse {
	data: ActivityEntry[];
	page: number;
	perPage: number;
	total: number;
	totalPages: number;
}

export async function activityCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';
	switch (subcommand) {
		case 'list':
		case 'ls':
			return listActivity(args.slice(1));
		default:
			// `hoststack activity --action service.created` is the obvious
			// thing to type, and there is only one verb here anyway.
			if (subcommand.startsWith('-')) return listActivity(args);
			printUsage();
			process.exit(1);
	}
}

function printUsage(): void {
	console.log(`${bold('Usage:')} hoststack activity [list] [filters]`);
	console.log();
	console.log('Filters:');
	console.log('  --action <a>           Exact action, e.g. service.created');
	console.log('  --type <t>             Resource type, e.g. service, deploy, domain');
	console.log('  --resource <id>        One resource’s own timeline (numeric id)');
	console.log('  --user <id>            Only what this user did (numeric id)');
	console.log('  --severity <s>         info | warning | error | critical');
	console.log('  --since <t> --until <t>  ISO-8601, or an offset like -15m / -2h / -7d');
	console.log('  --page <n> --per-page <n>  Paging (per-page max 100, default 25)');
	console.log('  --json                 The raw response, paging metadata included');
	console.log();
	console.log(`${bold('Examples:')}`);
	console.log(dim('  hoststack activity --since -2h'));
	console.log(dim('  hoststack activity --type deploy --per-page 10'));
	console.log(dim('  hoststack activity --action env_var.deleted --since -7d'));
	console.log();
	console.log(
		dim(
			'  Dev-box lifecycle events are hidden from the team feed; --resource <id> shows them.',
		),
	);
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	const value = args[idx + 1];
	return value !== undefined && !value.startsWith('--') ? value : undefined;
}

/** A numeric filter that refuses garbage here rather than matching nothing there. */
function numericFlag(args: string[], name: string): string | undefined {
	const raw = flag(args, name);
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw)) {
		console.error(red(`${name} must be a positive integer, got "${raw}".`));
		process.exit(1);
	}
	return raw;
}

function actor(entry: ActivityEntry): string {
	// A null user is the platform acting on its own — an orchestrator scale,
	// a sweep, a webhook. Saying "n/a" there reads as missing data; it is not.
	if (entry.userName) return entry.userName;
	if (entry.userEmail) return entry.userEmail;
	return dim('platform');
}

function subject(entry: ActivityEntry): string {
	if (!entry.resourceType && entry.resourceId === null) return dim('—');
	if (entry.resourceId === null) return entry.resourceType ?? dim('—');
	return `${entry.resourceType ?? '?'} ${entry.resourceId}`;
}

async function listActivity(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');
	const params = new URLSearchParams();
	const pairs: Array<[string, string | undefined]> = [
		['action', flag(args, '--action')],
		['resourceType', flag(args, '--type')],
		['resourceId', numericFlag(args, '--resource')],
		['userId', numericFlag(args, '--user')],
		['severity', flag(args, '--severity')],
		['since', flag(args, '--since')],
		['until', flag(args, '--until')],
		['page', numericFlag(args, '--page')],
		['perPage', numericFlag(args, '--per-page')],
	];
	for (const [key, value] of pairs) if (value !== undefined) params.set(key, value);
	const qs = params.toString();

	try {
		const response = await apiFetch<ActivityResponse>(
			`/api/activity-log/${teamId}${qs ? `?${qs}` : ''}`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(response, null, 2));
			return;
		}

		const entries = response.data ?? [];
		if (entries.length === 0) {
			console.log(dim('No activity matches those filters.'));
			return;
		}

		console.log(
			table(
				['When', 'Action', 'Subject', 'Who', 'From'],
				entries.map((e) => [
					formatDateTime(e.createdAt),
					e.severity === 'critical' || e.severity === 'error'
						? red(e.action)
						: e.severity === 'warning'
							? yellow(e.action)
							: e.action,
					subject(e),
					actor(e),
					e.ipAddress ?? dim('—'),
				]),
			),
		);

		// Paging stated rather than implied. A feed that silently shows page 1
		// of 40 is how "there is no record of it" gets said out loud.
		if (response.totalPages > 1) {
			console.log();
			console.log(
				dim(
					`Page ${response.page} of ${response.totalPages} — ${response.total} entries. Next: --page ${response.page + 1}`,
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}
