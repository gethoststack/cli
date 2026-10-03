import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatCount, formatDateTime } from '../lib/format.ts';
import { bold, cyan, dim, green, handleError, red, table, yellow } from '../lib/output.ts';

interface ErrorIssue {
	id: number;
	publicId: string;
	serviceId: number;
	serviceName: string | null;
	type: string;
	title: string;
	culprit: string | null;
	level: string;
	status: string;
	occurrenceCount: number;
	droppedCount: number;
	affectedUsers: number;
	firstSeenAt: string;
	lastSeenAt: string;
	lastSeenRelease: string | null;
	sourceTaskPublicId: string | null;
}

interface ErrorOccurrence {
	id: number;
	stack: string | null;
	context: Record<string, unknown> | null;
	requestId: string | null;
	release: string | null;
	createdAt: string;
}

interface IngestKey {
	id: number;
	name: string;
	prefix: string;
	lastUsedAt: string | null;
	key?: string;
}

/**
 * `hoststack errors` — the exceptions a team's own applications reported,
 * grouped by cause.
 *
 * Deliberately not a reporting client: sending an error uses a separate
 * write-only ingest key posted to a documented HTTP endpoint, because that
 * credential ships inside the application and must not be the one that can
 * read and change everything else. `errors keys new` mints one.
 */
export async function errorsCommand(args: string[]): Promise<void> {
	const subcommand = args[0];

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listIssues(args.slice(1));
		case 'show':
		case 'get':
			return showIssue(args.slice(1));
		case 'resolve':
			return setStatus(args.slice(1), 'resolved');
		case 'ignore':
			return setStatus(args.slice(1), 'ignored');
		case 'reopen':
			return setStatus(args.slice(1), 'unresolved');
		case 'fix':
			return fixInDevBox(args.slice(1));
		case 'keys':
			return keysCommand(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack errors <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list [--service <id>] [--status <s>] [--sort count] [--json]');
			console.log('  show <issue-id> [--json]        Issue plus recent stack traces');
			console.log('  resolve <issue-id>              Fixed — tell me if it comes back');
			console.log('  ignore <issue-id>               Keep counting, stop telling me');
			console.log('  reopen <issue-id>               Undo resolve/ignore');
			console.log('  fix <issue-id>                  Write an agent task in the dev box');
			console.log('  keys list <service-id>          Ingest keys on a service');
			console.log('  keys new <service-id> [name]    Mint a write-only ingest key');
			console.log('  keys rm <service-id> <key-id>   Revoke a key');
			process.exit(1);
	}
}

function requireTeam(): number {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	return teamId;
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx === -1 ? undefined : args[idx + 1];
}

/** "3m ago" is what you scan a list for; a timestamp is what you read after. */
function relative(iso: string): string {
	const seconds = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

async function listIssues(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const params = new URLSearchParams();
	const service = flag(args, '--service');
	const status = flag(args, '--status');
	const sort = flag(args, '--sort');
	const limit = flag(args, '--limit');
	if (service) params.set('serviceId', service);
	if (status) params.set('status', status);
	if (sort) params.set('sort', sort);
	if (limit) params.set('limit', limit);

	try {
		const qs = params.toString();
		const data = await apiFetch<{ issues: ErrorIssue[]; total: number }>(
			`/api/errors/${teamId}/issues${qs ? `?${qs}` : ''}`,
		);

		if (args.includes('--json')) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		if (data.issues.length === 0) {
			console.log(
				dim(
					`No ${status ?? 'unresolved'} issues. If you expected some, check that the service has an ingest key and that your app is posting to it: hoststack errors keys list <service-id>`,
				),
			);
			return;
		}

		console.log(
			table(
				['ID', 'ISSUE', 'WHERE', 'EVENTS', 'USERS', 'LAST'],
				data.issues.map((issue) => [
					String(issue.id),
					issue.title.length > 60 ? `${issue.title.slice(0, 57)}…` : issue.title,
					issue.culprit ?? dim('—'),
					formatCount(issue.occurrenceCount),
					issue.affectedUsers >= 500 ? '500+' : String(issue.affectedUsers),
					relative(issue.lastSeenAt),
				]),
			),
		);
		console.log();
		console.log(dim(`${data.total} issue(s). Details: hoststack errors show <id>`));
	} catch (err) {
		handleError(err);
	}
}

async function showIssue(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const issueId = args[0];
	if (!issueId) {
		console.log(`${bold('Usage:')} hoststack errors show <issue-id>`);
		process.exit(1);
	}

	try {
		const [{ issue }, { occurrences }] = await Promise.all([
			apiFetch<{ issue: ErrorIssue }>(`/api/errors/${teamId}/issues/${issueId}`),
			apiFetch<{ occurrences: ErrorOccurrence[] }>(
				`/api/errors/${teamId}/issues/${issueId}/occurrences?limit=3`,
			),
		]);

		if (args.includes('--json')) {
			console.log(JSON.stringify({ issue, occurrences }, null, 2));
			return;
		}

		console.log(bold(issue.title));
		if (issue.culprit) console.log(cyan(issue.culprit));
		console.log();
		console.log(
			`${dim('Service')}   ${issue.serviceName ?? issue.serviceId}    ${dim('Status')}  ${issue.status}    ${dim('Level')}  ${issue.level}`,
		);
		console.log(
			`${dim('Events')}    ${formatCount(issue.occurrenceCount)}    ${dim('Users')}  ${
				issue.affectedUsers >= 500 ? '500+' : issue.affectedUsers
			}`,
		);
		console.log(
			`${dim('First')}     ${relative(issue.firstSeenAt)}    ${dim('Last')}   ${relative(issue.lastSeenAt)}${
				issue.lastSeenRelease
					? `    ${dim('Release')} ${issue.lastSeenRelease.slice(0, 7)}`
					: ''
			}`,
		);
		if (issue.droppedCount > 0) {
			console.log(
				yellow(
					`${formatCount(issue.droppedCount)} occurrence(s) counted but not stored — this service went over its hourly ingest quota. The count above is still accurate.`,
				),
			);
		}
		if (issue.sourceTaskPublicId) {
			console.log(green(`An agent task is already open for this issue.`));
		}

		for (const occurrence of occurrences) {
			console.log();
			console.log(
				dim(
					`── ${formatDateTime(occurrence.createdAt)}${occurrence.requestId ? ` · request ${occurrence.requestId}` : ''}${occurrence.release ? ` · ${occurrence.release.slice(0, 7)}` : ''}`,
				),
			);
			if (occurrence.stack) console.log(occurrence.stack);
			if (occurrence.context) console.log(dim(JSON.stringify(occurrence.context)));
		}
		if (occurrences.length === 0) {
			console.log();
			console.log(
				dim(
					'No stored samples left — occurrences age out after 30 days while the issue itself stays.',
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

async function setStatus(args: string[], status: string): Promise<void> {
	const teamId = requireTeam();
	const issueId = args[0];
	if (!issueId) {
		console.log(
			`${bold('Usage:')} hoststack errors ${status === 'resolved' ? 'resolve' : status === 'ignored' ? 'ignore' : 'reopen'} <issue-id>`,
		);
		process.exit(1);
	}
	try {
		await apiFetch(`/api/errors/${teamId}/issues/${issueId}`, {
			method: 'PATCH',
			body: JSON.stringify({ status }),
		});
		console.log(
			status === 'resolved'
				? green(`Issue ${issueId} resolved. You will be told if it happens again.`)
				: status === 'ignored'
					? green(`Issue ${issueId} ignored. It keeps counting; you stop being told.`)
					: green(`Issue ${issueId} reopened.`),
		);
	} catch (err) {
		handleError(err);
	}
}

async function fixInDevBox(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const issueId = args[0];
	if (!issueId) {
		console.log(`${bold('Usage:')} hoststack errors fix <issue-id> [--box <service-id>]`);
		process.exit(1);
	}
	const box = flag(args, '--box');

	try {
		const result = await apiFetch<{
			task: { title: string };
			alreadyExisted: boolean;
			box: { serviceId: number; name: string; asleep: boolean };
			automodeEnabled: boolean;
		}>(`/api/dev-env-tasks/${teamId}/from-issue`, {
			method: 'POST',
			body: JSON.stringify({
				issueId: Number.parseInt(issueId, 10),
				...(box ? { serviceId: Number.parseInt(box, 10) } : {}),
			}),
		});

		console.log(
			green(
				`${result.alreadyExisted ? 'Already queued' : 'Queued'} in ${result.box.name}: ${result.task.title}`,
			),
		);
		console.log(
			dim(
				result.box.asleep
					? 'That box is asleep — resume it, then start the task from the dashboard.'
					: 'The task is written, not started. Open the box to read the prompt and run it.',
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function keysCommand(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const action = args[0];
	const serviceId = args[1];

	if (!action || !serviceId) {
		console.log(`${bold('Usage:')} hoststack errors keys <list|new|rm> <service-id> [...]`);
		process.exit(1);
	}

	try {
		if (action === 'list' || action === 'ls') {
			const { keys } = await apiFetch<{ keys: IngestKey[] }>(
				`/api/services/${teamId}/${serviceId}/ingest-keys`,
			);
			if (keys.length === 0) {
				console.log(
					dim(
						'No ingest keys. This service cannot report errors yet — run: hoststack errors keys new <service-id>',
					),
				);
				return;
			}
			console.log(
				table(
					['ID', 'NAME', 'PREFIX', 'LAST USED'],
					keys.map((key) => [
						String(key.id),
						key.name,
						`${key.prefix}…`,
						key.lastUsedAt ? relative(key.lastUsedAt) : dim('never'),
					]),
				),
			);
			return;
		}

		if (action === 'new' || action === 'create') {
			const { key } = await apiFetch<{ key: IngestKey }>(
				`/api/services/${teamId}/${serviceId}/ingest-keys`,
				{ method: 'POST', body: JSON.stringify({ name: args[2] ?? 'default' }) },
			);
			console.log(bold('Ingest key (shown once — it is stored only as a hash):'));
			console.log();
			console.log(`  ${key.key ?? ''}`);
			console.log();
			console.log(dim('Post errors to:'));
			console.log(`  POST /api/ingest/errors/${key.key ?? '<key>'}`);
			console.log();
			console.log(
				dim(
					'This key can only create error events for this one service — it reads nothing. Shipping it inside your application, including a browser bundle, is expected.',
				),
			);
			return;
		}

		if (action === 'rm' || action === 'delete' || action === 'revoke') {
			const keyId = args[2];
			if (!keyId) {
				console.log(`${bold('Usage:')} hoststack errors keys rm <service-id> <key-id>`);
				process.exit(1);
			}
			await apiFetch(`/api/services/${teamId}/${serviceId}/ingest-keys/${keyId}`, {
				method: 'DELETE',
			});
			console.log(green(`Key ${keyId} revoked. Anything still using it now gets a 401.`));
			return;
		}

		console.log(`${bold('Usage:')} hoststack errors keys <list|new|rm> <service-id> [...]`);
		process.exit(1);
	} catch (err) {
		handleError(err);
	}
}
