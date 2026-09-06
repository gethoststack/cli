import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, table, yellow } from '../lib/output.ts';

interface UptimeCheck {
	id: number;
	serviceId: number | null;
	siteId: number | null;
	enabled: boolean;
	path: string;
	method: string;
	expectedStatus: number;
	timeoutMs: number;
	intervalSeconds: number;
	failureThreshold: number;
	status: string;
	consecutiveFailures: number;
	lastCheckedAt: string | null;
	lastStatusCode: number | null;
	lastLatencyMs: number | null;
	lastError: string | null;
	lastChangedAt: string | null;
}

/** One line per status, so `hoststack uptime get` explains itself. */
const STATUS_MEANING: Record<string, string> = {
	up: 'Answering as expected.',
	down: 'Not answering — an alert is open.',
	unknown: 'Not checked yet.',
	unresolvable:
		"Nothing to request — no active domain on the service, or the site's domain is not proven.",
	paused: 'Not being checked right now.',
};

/**
 * `hoststack uptime` — HostStack requesting a service's public URL on a
 * schedule and telling the team when it stops answering.
 *
 * Not the same thing as the deploy-time health check, and the difference is
 * the point: the health check watches the container from inside the host and
 * stops mattering once a deploy is live. This runs from outside, so it also
 * catches DNS, TLS and routing failures — and a service that accepts the
 * connection and then answers nothing.
 *
 * `--site <id>` checks an analytics site instead of a service, which is how a
 * site HostStack does not host gets watched at all. That target needs its
 * domain proven first (`hoststack analytics verify <site-id>`): the probe makes
 * the control plane fetch the hostname on a schedule from HostStack's own IP,
 * so it must be a name the team has shown it owns.
 */
export async function uptimeCommand(args: string[]): Promise<void> {
	const subcommand = args[0];

	switch (subcommand) {
		case 'get':
		case 'status':
			return getCheck(args.slice(1));
		case 'set':
		case 'enable':
			return setCheck(args.slice(1));
		case 'disable':
			return setCheck([...args.slice(1), '--enabled', 'false']);
		case 'rm':
		case 'remove':
		case 'delete':
			return removeCheck(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack uptime <command>`);
			console.log();
			console.log('Commands:');
			console.log(
				'  get <service-id>                        Show the check and its last result',
			);
			console.log('  set <service-id> [--path /healthz]      Create or update the check');
			console.log('           [--status 200] [--every 60] [--timeout 10000] [--after 3]');
			console.log('  disable <service-id>                    Keep the config, stop probing');
			console.log('  rm <service-id>                         Delete the check');
			console.log();
			console.log('  Any of the above accept --site <site-id> instead of a service id, to');
			console.log('  watch a site HostStack does not host (see: hoststack analytics sites).');
			console.log();
			console.log(
				dim('Only services with a public URL (web services, static sites) can be checked.'),
			);
			console.log(
				dim(
					'A --site target needs its domain proven first: hoststack analytics verify <site-id>.',
				),
			);
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

/**
 * Which endpoint this invocation is talking to.
 *
 * `--site 3` and a bare service id are two different resources, not two ways
 * of naming one — a site check has no service and vice versa — so the target
 * is resolved once here rather than being re-derived in each subcommand.
 */
function target(teamId: number, args: string[], usage: string): { url: string; label: string } {
	const siteId = flag(args, '--site');
	if (siteId !== undefined) {
		return {
			url: `/api/analytics/${teamId}/sites/${siteId}/uptime-check`,
			label: `site ${siteId}`,
		};
	}
	const serviceId = args[0];
	if (!serviceId || serviceId.startsWith('--')) {
		console.log(`${bold('Usage:')} ${usage}`);
		process.exit(1);
	}
	return {
		url: `/api/services/${teamId}/${serviceId}/uptime-check`,
		label: `service ${serviceId}`,
	};
}

async function getCheck(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const { url, label } = target(
		teamId,
		args,
		'hoststack uptime get <service-id> | --site <site-id>',
	);

	try {
		const { check } = await apiFetch<{ check: UptimeCheck | null }>(url);

		if (args.includes('--json')) {
			console.log(JSON.stringify(check, null, 2));
			return;
		}

		if (check === null) {
			console.log(dim(`No uptime check on ${label}. Create one: hoststack uptime set …`));
			return;
		}

		const tone = check.status === 'up' ? green : check.status === 'down' ? red : yellow;
		console.log(
			`${bold('Status')}  ${tone(check.status)} — ${STATUS_MEANING[check.status] ?? ''}`,
		);
		if (check.lastError) console.log(`${bold('Detail')}  ${check.lastError}`);
		if (check.status === 'down' && check.lastChangedAt) {
			console.log(`${bold('Since')}   ${new Date(check.lastChangedAt).toLocaleString()}`);
		}
		console.log();
		console.log(
			table(
				['PATH', 'METHOD', 'EXPECT', 'EVERY', 'TIMEOUT', 'ALERT AFTER', 'ENABLED'],
				[
					[
						check.path,
						check.method,
						String(check.expectedStatus),
						`${check.intervalSeconds}s`,
						`${check.timeoutMs}ms`,
						`${check.failureThreshold} failures`,
						check.enabled ? 'yes' : 'no',
					],
				],
			),
		);
		if (check.lastCheckedAt) {
			console.log();
			console.log(
				dim(
					`Last checked ${new Date(check.lastCheckedAt).toLocaleString()}${
						check.lastStatusCode !== null
							? ` — HTTP ${check.lastStatusCode} in ${check.lastLatencyMs ?? 0}ms`
							: ''
					}`,
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

async function setCheck(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const { url } = target(
		teamId,
		args,
		'hoststack uptime set <service-id> | --site <site-id> [--path /healthz]',
	);

	const body: Record<string, unknown> = {};
	const path = flag(args, '--path');
	const status = flag(args, '--status');
	const every = flag(args, '--every');
	const timeout = flag(args, '--timeout');
	const after = flag(args, '--after');
	const enabled = flag(args, '--enabled');
	if (path) body['path'] = path;
	if (status) body['expectedStatus'] = Number.parseInt(status, 10);
	if (every) body['intervalSeconds'] = Number.parseInt(every, 10);
	if (timeout) body['timeoutMs'] = Number.parseInt(timeout, 10);
	if (after) body['failureThreshold'] = Number.parseInt(after, 10);
	if (enabled) body['enabled'] = enabled !== 'false';

	try {
		const { check } = await apiFetch<{ check: UptimeCheck }>(url, {
			method: 'PUT',
			body: JSON.stringify(body),
		});
		console.log(
			green(
				`Uptime check saved: ${check.method} ${check.path} every ${check.intervalSeconds}s, expecting HTTP ${check.expectedStatus}.`,
			),
		);
		// Worth stating plainly: an edit resets accumulated state, so the
		// status going back to "unknown" is the intended behaviour and not the
		// check having broken.
		console.log(
			dim(
				'Editing a check resets its recorded state — it has not observed the new check failing yet, so it starts from unknown.',
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function removeCheck(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const { url, label } = target(
		teamId,
		args,
		'hoststack uptime rm <service-id> | --site <site-id>',
	);
	try {
		await apiFetch(url, { method: 'DELETE' });
		console.log(green(`Uptime check removed. Nothing is watching ${label} now.`));
	} catch (err) {
		handleError(err);
	}
}
