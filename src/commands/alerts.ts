import { apiFetch } from '../lib/api.ts';
import { NOTIFICATION_EVENTS, isNotificationEvent } from '../lib/catalog.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDateTime } from '../lib/format.ts';
import { bold, cyan, dim, green, handleError, red, spinner, table, yellow } from '../lib/output.ts';

/**
 * Alerts and the channels they are delivered to, from the terminal.
 *
 * Deciding where a team's alerts go is a first-day task, and it was
 * dashboard-or-MCP only: `hoststack` had no `alerts` command at all, so
 * somebody setting a project up from a shell could not see what was on fire,
 * let alone arrange to be told about the next one.
 *
 * Two things this surface keeps separate, because the API does and the
 * distinction is the whole point of having both:
 *
 *   - `resolve` says the condition ENDED. It writes the same `resolved_at`
 *     stamp every automatic recovery path writes, and it is for a row nothing
 *     on the platform will ever close by itself — an ACME failure for a domain
 *     that has since been removed, a deploy failure on a deleted service.
 *   - `ack` says only "I have seen it". The alert stays open and stays true;
 *     it just stops competing for attention until the mute expires.
 *
 * Collapsing them into one verb is how a monitoring surface starts lying,
 * either by marking live faults fixed or by shouting at people who already
 * know.
 */

interface AggregatedAlert {
	action: string;
	resourceType: string | null;
	resourceId: number | null;
	severity: string;
	count: number;
	firstFiredAt: string;
	lastFiredAt: string;
	lastResolvedAt: string | null;
	active: boolean;
	lastMetadata: unknown;
}

interface RawAlert {
	id: number;
	action: string;
	resourceType: string | null;
	resourceId: number | null;
	severity: string;
	metadata: unknown;
	createdAt: string;
	resolvedAt: string | null;
}

interface AlertsResponse {
	alerts: AggregatedAlert[] | RawAlert[];
	aggregated: boolean;
	activeOnly: boolean;
}

type ChannelType = 'slack' | 'discord' | 'email';

interface NotificationChannel {
	id: number;
	type: ChannelType;
	name: string;
	/** Masked by the API on list — only create/update round-trip the real value. */
	webhookUrl: string;
	active: boolean;
	events: string[];
	createdAt: string;
}

export async function alertsCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listAlerts(args.slice(1));
		case 'resolve':
			return resolveAlert(args.slice(1));
		case 'ack':
		case 'acknowledge':
			return ackAlert(args.slice(1));
		case 'unack':
		case 'unacknowledge':
			return unackAlert(args.slice(1));
		case 'channels':
		case 'channel':
			return channelsCommand(args.slice(1));
		case 'events':
			return listEvents(args.slice(1));
		default:
			// A bare `hoststack alerts --since -1h` is the obvious thing to type
			// and means `list`. Only a non-flag first word is a subcommand.
			if (subcommand.startsWith('-')) return listAlerts(args);
			printUsage();
			process.exit(1);
	}
}

function printUsage(): void {
	console.log(`${bold('Usage:')} hoststack alerts <command>`);
	console.log();
	console.log('Commands:');
	console.log('  list [--since -1h] [--limit N] [--raw] [--all] [--json]');
	console.log('                            What is on fire (default: every open alert;');
	console.log('                            --since/--all bound the cleared history)');
	console.log('  resolve <identity>        Mark the condition ENDED (writes resolved_at)');
	console.log('  ack <identity> [--hours N] [--note "..."]   Mute it without closing it');
	console.log('  unack <identity>          Un-mute it');
	console.log();
	console.log('  channels [--json]         Where alerts are delivered');
	console.log(
		'  channels add --type slack|discord|email --name <n> --url <u> --events <a,b|all>',
	);
	console.log('  channels update <id> [--name <n>] [--on|--off] [--events <a,b|all>]');
	console.log('  channels test <id>        Fire a test event at it');
	console.log('  channels delete <id>');
	console.log('  events [--json]           Every event a channel can subscribe to');
	console.log();
	console.log(`${bold('Identity')} (an alert is a group, not a row — all four fields):`);
	console.log('  --action <a> --severity info|warning|error|critical');
	console.log('  [--type <resource-type>] [--id <resource-id>]');
	console.log(dim('  Copy them straight off `hoststack alerts list --json`.'));
	console.log();
	console.log(`${bold('Examples:')}`);
	console.log(dim('  hoststack alerts --since -6h'));
	console.log(dim('  hoststack alerts resolve --action service.acme_cert_failed \\'));
	console.log(dim('      --severity error --type service --id 31'));
	console.log(dim('  hoststack alerts channels add --type slack --name ops \\'));
	console.log(
		dim('      --url https://hooks.slack.com/... --events deploy.failed,database.failed'),
	);
}

function requireTeam(): number | string {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	return teamId;
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	const value = args[idx + 1];
	return value !== undefined && !value.startsWith('--') ? value : undefined;
}

/** Severity, coloured by how much of the night it is allowed to cost. */
function severityBadge(severity: string): string {
	switch (severity) {
		case 'critical':
			return red(bold('critical'));
		case 'error':
			return red('error');
		case 'warning':
			return yellow('warning');
		default:
			return dim(severity);
	}
}

function subject(resourceType: string | null, resourceId: number | null): string {
	if (!resourceType && resourceId === null) return dim('team-wide');
	if (resourceId === null) return resourceType ?? dim('—');
	return `${resourceType ?? '?'} ${resourceId}`;
}

async function listAlerts(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const jsonFlag = args.includes('--json');
	const raw = args.includes('--raw');
	// `--all` means "resolved history too". The default is deliberately the
	// narrow one: triage starts at "what is broken right now", and a feed that
	// opens on six months of cleared cron failures is not triage.
	const includeResolved = args.includes('--all');

	const params = new URLSearchParams();
	const since = flag(args, '--since');
	const until = flag(args, '--until');
	const limit = flag(args, '--limit');
	if (since) params.set('since', since);
	if (until) params.set('until', until);
	if (limit) params.set('limit', limit);
	if (raw) params.set('aggregate', '0');
	if (includeResolved) params.set('active', '0');
	const qs = params.toString();

	try {
		const data = await apiFetch<AlertsResponse>(`/api/alerts/${teamId}${qs ? `?${qs}` : ''}`);

		if (jsonFlag) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		if (data.alerts.length === 0) {
			console.log(
				data.activeOnly
					? green('Nothing is on fire.') +
							dim(' (active alerts only — pass --all for resolved history)')
					: dim('No alerts in that window.'),
			);
			return;
		}

		if (!data.aggregated) {
			const rows = data.alerts as RawAlert[];
			console.log(
				table(
					['When', 'Severity', 'Action', 'Subject', 'State'],
					rows.map((a) => [
						formatDateTime(a.createdAt),
						severityBadge(a.severity),
						a.action,
						subject(a.resourceType, a.resourceId),
						a.resolvedAt ? dim('resolved') : red('open'),
					]),
				),
			);
			return;
		}

		const rows = data.alerts as AggregatedAlert[];
		console.log(
			table(
				['Severity', 'Action', 'Subject', 'Fired', 'Last', 'State'],
				rows.map((a) => [
					severityBadge(a.severity),
					a.action,
					subject(a.resourceType, a.resourceId),
					// A flapping service is one row with a count, not eighty rows.
					// The count is the interesting number; hide the 1s.
					a.count > 1 ? `${a.count}x` : '',
					formatDateTime(a.lastFiredAt),
					a.active ? red('ON FIRE') : dim('cleared'),
				]),
			),
		);

		const active = rows.filter((a) => a.active);
		if (active.length > 0) {
			console.log();
			console.log(
				dim(
					`${active.length} still open. Close one with: hoststack alerts resolve --action <action> --severity <severity> [--type <t>] [--id <n>]`,
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

/**
 * The four fields that identify ONE row on the alerts page, matching the
 * endpoint's own GROUP BY.
 *
 * Severity is required rather than inferred because it is part of the group:
 * without it, clearing a warning would also clear the critical that same
 * subject later escalated into. `--type`/`--id` are genuinely optional — a
 * team-wide alert has neither, and null has to reach the query as NULL.
 */
const SEVERITIES = ['info', 'warning', 'error', 'critical'];

function readIdentity(
	args: string[],
	verb: string,
): { action: string; severity: string; resourceType: string | null; resourceId: number | null } {
	const action = flag(args, '--action');
	const severity = flag(args, '--severity');
	if (!action || !severity) {
		console.log(
			`${bold('Usage:')} hoststack alerts ${verb} --action <action> --severity <${SEVERITIES.join('|')}> [--type <resource-type>] [--id <resource-id>]`,
		);
		console.log();
		console.log(dim('All four fields come straight off `hoststack alerts list --json`.'));
		process.exit(1);
	}
	if (!SEVERITIES.includes(severity)) {
		console.error(red(`Unknown severity "${severity}". One of: ${SEVERITIES.join(', ')}.`));
		process.exit(1);
	}
	const rawId = flag(args, '--id');
	let resourceId: number | null = null;
	if (rawId !== undefined) {
		const parsed = Number.parseInt(rawId, 10);
		if (!Number.isInteger(parsed)) {
			console.error(red(`--id must be a number, got "${rawId}".`));
			process.exit(1);
		}
		resourceId = parsed;
	}
	return { action, severity, resourceType: flag(args, '--type') ?? null, resourceId };
}

async function resolveAlert(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const identity = readIdentity(args, 'resolve');

	const s = spinner('Resolving...');
	try {
		// The endpoint reports how many rows it closed, and a resolve that
		// matched nothing is a 404 rather than a cheerful no-op — the button
		// appearing to work while the row stayed put is how people learn to
		// stop trusting the page.
		const { resolved } = await apiFetch<{ resolved: number }>(`/api/alerts/${teamId}/resolve`, {
			method: 'POST',
			body: JSON.stringify(identity),
		});
		s.stop(green(`Closed ${resolved} entr${resolved === 1 ? 'y' : 'ies'}`));
		console.log(dim('Recorded as alert.resolved_manually in the activity log.'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function ackAlert(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const identity = readIdentity(args, 'ack');
	const body: Record<string, unknown> = { ...identity };

	const hours = flag(args, '--hours');
	if (hours !== undefined) {
		const parsed = Number.parseInt(hours, 10);
		if (!Number.isInteger(parsed) || parsed < 1) {
			console.error(red(`--hours must be a positive number, got "${hours}".`));
			process.exit(1);
		}
		body.hours = parsed;
	}
	const note = flag(args, '--note');
	if (note !== undefined) body.note = note;

	const s = spinner('Acknowledging...');
	try {
		const { mutedUntil } = await apiFetch<{ acknowledged: boolean; mutedUntil: string }>(
			`/api/alerts/${teamId}/ack`,
			{ method: 'POST', body: JSON.stringify(body) },
		);
		s.stop(green(`Muted until ${formatDateTime(mutedUntil)}`));
		// Said every time, because this is the half people misread: an ack is
		// not a fix, and the thing is still broken when the mute expires.
		console.log(dim('The alert is still open and still true — only quiet.'));
		console.log(dim('To say the condition ended instead: hoststack alerts resolve …'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function unackAlert(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const identity = readIdentity(args, 'unack');

	const s = spinner('Removing acknowledgement...');
	try {
		await apiFetch(`/api/alerts/${teamId}/ack`, {
			method: 'DELETE',
			body: JSON.stringify(identity),
		});
		s.stop('Un-muted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

// ── Channels ─────────────────────────────────────────────────────────────

async function channelsCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';
	switch (subcommand) {
		case 'list':
		case 'ls':
			return listChannels(args.slice(1));
		case 'add':
		case 'create':
			return addChannel(args.slice(1));
		case 'update':
		case 'edit':
			return updateChannel(args.slice(1));
		case 'test':
			return testChannel(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteChannel(args.slice(1));
		default:
			if (subcommand.startsWith('-')) return listChannels(args);
			printUsage();
			process.exit(1);
	}
}

async function listChannels(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const jsonFlag = args.includes('--json');

	try {
		const { channels } = await apiFetch<{ channels: NotificationChannel[] }>(
			`/api/notifications/${teamId}/channels`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(channels, null, 2));
			return;
		}
		if (channels.length === 0) {
			console.log(dim('No notification channels. Nothing is being delivered anywhere.'));
			console.log(
				dim('Add one with: hoststack alerts channels add --type slack --name ops --url …'),
			);
			return;
		}

		console.log(
			table(
				['ID', 'Type', 'Name', 'Destination', 'State', 'Events'],
				channels.map((c) => [
					String(c.id),
					c.type,
					c.name,
					// Already masked server-side, so this is safe to paste.
					c.webhookUrl,
					c.active ? green('on') : dim('off'),
					// A channel subscribed to nothing is off in every way that
					// matters while reading as "on", so say the number.
					c.events.length === 0 ? red('none') : String(c.events.length),
				]),
			),
		);

		const silent = channels.filter((c) => c.active && c.events.length === 0);
		if (silent.length > 0) {
			console.log();
			console.log(
				yellow(
					`${silent.length} active channel${silent.length === 1 ? '' : 's'} subscribed to no events — ${silent.length === 1 ? 'it delivers' : 'they deliver'} nothing.`,
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

/**
 * `--events` takes a comma list, or the literal `all`.
 *
 * There is no default. The dashboard pre-selects a critical set for a human
 * who can see the checkboxes; a CLI caller who typed no list and got one
 * chosen for them would be subscribed to things they never asked for, and
 * would find out from their phone.
 */
function readEvents(args: string[], required: boolean): string[] | undefined {
	const raw = flag(args, '--events');
	if (raw === undefined) {
		if (!required) return undefined;
		console.error(red('--events is required. Pass a comma list, or "all".'));
		console.error(dim('See them all with: hoststack alerts events'));
		process.exit(1);
	}
	if (raw === 'all') return [...NOTIFICATION_EVENTS];
	const events = raw
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean);
	if (events.length === 0) {
		console.error(red('--events was empty. Pass a comma list, or "all".'));
		process.exit(1);
	}
	const unknown = events.filter((e) => !isNotificationEvent(e));
	if (unknown.length > 0) {
		console.error(red(`Not an event: ${unknown.join(', ')}`));
		console.error(dim('See them all with: hoststack alerts events'));
		process.exit(1);
	}
	return events;
}

const CHANNEL_TYPES: ChannelType[] = ['slack', 'discord', 'email'];

async function addChannel(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const type = flag(args, '--type');
	const name = flag(args, '--name');
	const url = flag(args, '--url') ?? flag(args, '--email');

	if (!type || !name || !url) {
		console.log(
			`${bold('Usage:')} hoststack alerts channels add --type <${CHANNEL_TYPES.join('|')}> --name <name> --url <webhook-url|email> --events <a,b|all>`,
		);
		console.log();
		console.log(dim('  --url is the incoming webhook for slack/discord, or the address for'));
		console.log(dim('  email. It cannot be changed later — make a new channel instead.'));
		process.exit(1);
	}
	if (!CHANNEL_TYPES.includes(type as ChannelType)) {
		console.error(red(`Unknown type "${type}". One of: ${CHANNEL_TYPES.join(', ')}.`));
		process.exit(1);
	}
	const events = readEvents(args, true)!;

	const s = spinner('Creating channel...');
	try {
		const { channel } = await apiFetch<{ channel: NotificationChannel }>(
			`/api/notifications/${teamId}/channels`,
			{
				method: 'POST',
				body: JSON.stringify({ type, name, webhookUrl: url, events }),
			},
		);
		s.stop('Channel created');
		console.log(
			`${green('+')} ${bold(channel.name)} ${dim(`(${channel.type}, id ${channel.id}, ${channel.events.length} events)`)}`,
		);
		console.log();
		console.log(`Prove it works: ${cyan(`hoststack alerts channels test ${channel.id}`)}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function updateChannel(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const channelId = args[0];
	if (!channelId || channelId.startsWith('--')) {
		console.log(
			`${bold('Usage:')} hoststack alerts channels update <channel-id> [--name <name>] [--on|--off] [--events <a,b|all>]`,
		);
		console.log();
		console.log(dim('  The type and destination URL are immutable — create a new channel.'));
		process.exit(1);
	}

	const body: Record<string, unknown> = {};
	const name = flag(args, '--name');
	if (name !== undefined) body.name = name;
	if (args.includes('--on')) body.active = true;
	if (args.includes('--off')) body.active = false;
	if (args.includes('--on') && args.includes('--off')) {
		console.error(red('Pass --on or --off, not both.'));
		process.exit(1);
	}
	const events = readEvents(args, false);
	if (events !== undefined) body.events = events;

	if (Object.keys(body).length === 0) {
		console.error(red('Nothing to change. Pass --name, --on/--off, or --events.'));
		process.exit(1);
	}

	const s = spinner('Updating channel...');
	try {
		const { channel } = await apiFetch<{ channel: NotificationChannel }>(
			`/api/notifications/${teamId}/channels/${channelId}`,
			{ method: 'PATCH', body: JSON.stringify(body) },
		);
		s.stop('Updated');
		console.log(
			`${bold(channel.name)} ${dim(`— ${channel.active ? 'on' : 'off'}, ${channel.events.length} events`)}`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function testChannel(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const channelId = args[0];
	if (!channelId) {
		console.log(`${bold('Usage:')} hoststack alerts channels test <channel-id>`);
		process.exit(1);
	}

	const s = spinner('Sending a test event...');
	try {
		const result = await apiFetch<{ success: boolean; error?: string }>(
			`/api/notifications/${teamId}/channels/${channelId}/test`,
			{ method: 'POST' },
		);
		// A 200 here means the dispatch was ATTEMPTED, not that it landed —
		// the outcome is in the body. Reporting "sent" on any 200 is the same
		// mistake `domains verify` used to make.
		if (result.success) {
			s.stop(green('Delivered'));
			console.log(dim('Check the destination — the message should already be there.'));
			return;
		}
		s.stop(red('Not delivered'));
		console.log(result.error ?? dim('The provider rejected it and said nothing useful.'));
		process.exit(1);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteChannel(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const channelId = args[0];
	if (!channelId) {
		console.log(`${bold('Usage:')} hoststack alerts channels delete <channel-id>`);
		console.log();
		console.log(dim('Alerts subscribed only to this channel stop being delivered anywhere.'));
		process.exit(1);
	}

	const s = spinner('Deleting channel...');
	try {
		await apiFetch(`/api/notifications/${teamId}/channels/${channelId}`, { method: 'DELETE' });
		s.stop('Channel deleted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

function listEvents(args: string[]): void {
	if (args.includes('--json')) {
		console.log(JSON.stringify(NOTIFICATION_EVENTS, null, 2));
		return;
	}
	// Grouped by prefix, because 48 flat strings is a wall and the prefix is
	// how people actually think about them ("everything deploy", "everything
	// database").
	const groups = new Map<string, string[]>();
	for (const event of NOTIFICATION_EVENTS) {
		const prefix = event.split('.')[0] ?? event;
		const bucket = groups.get(prefix);
		if (bucket) bucket.push(event);
		else groups.set(prefix, [event]);
	}
	for (const [prefix, events] of groups) {
		console.log(bold(prefix));
		for (const event of events) console.log(`  ${event}`);
	}
	console.log();
	console.log(dim('Subscribe with: hoststack alerts channels add … --events a,b'));
	console.log(dim('Or all of them: --events all'));
}
