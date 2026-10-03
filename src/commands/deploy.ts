import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDateTime } from '../lib/format.ts';
import { resolveEnvironmentId } from '../lib/resolve.ts';
import {
	bold,
	cyan,
	dim,
	green,
	handleError,
	red,
	spinner,
	statusBadge,
	table,
} from '../lib/output.ts';

interface Deploy {
	id: number;
	publicId: string;
	status: string;
	trigger: string;
	commitHash?: string | null;
	commitMessage?: string | null;
	createdAt: string;
	finishedAt?: string | null;
}

export async function deployCommand(args: string[]): Promise<void> {
	const subcommand = args[0];

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listDeploys(args.slice(1));
		case 'trigger':
		case 'create':
			return triggerDeploy(args.slice(1));
		case 'logs':
			return deployLogs(args.slice(1));
		case 'cancel':
			return cancelDeploy(args.slice(1));
		case 'rollback':
			return rollbackDeploy(args.slice(1));
		case 'diagnose':
			return diagnoseDeploy(args.slice(1));
		case 'promote':
			return promoteDeploy(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack deploy <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list <service-id>                      List deploys for a service');
			console.log(
				'  trigger <service-id> [--commit <hash>] [--branch <name>] [--clear-cache]',
			);
			console.log('                                         Trigger a new deploy');
			console.log('  logs <service-id> <deploy-id>          View deploy build logs');
			console.log('  cancel <service-id> <deploy-id>        Cancel an in-progress deploy');
			console.log('  rollback <service-id> <deploy-id>      Rollback to a previous deploy');
			console.log(
				'  diagnose <service-id> <deploy-id>      Deploy record + build log + runtime log',
			);
			console.log(
				'  promote <service-id> <deploy-id> --to <env>   Run this build in another env',
			);
			process.exit(1);
	}
}

async function listDeploys(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack deploy list <service-id> [--json]`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		// Deploys list is paginated and returns `{ data, ... }` — not the bare
		// `{ deploys: [] }` shape every other list endpoint uses.
		const response = await apiFetch<{
			data: Deploy[];
			page: number;
			perPage: number;
			total: number;
			totalPages: number;
		}>(`/api/services/${teamId}/${serviceId}/deploys`);
		const deploys = response.data;

		if (jsonFlag) {
			console.log(JSON.stringify(deploys, null, 2));
			return;
		}

		if (deploys.length === 0) {
			console.log(dim('No deploys found.'));
			return;
		}

		console.log(
			table(
				['ID', 'Status', 'Trigger', 'Commit', 'Created'],
				deploys.map((d) => [
					d.publicId,
					statusBadge(d.status),
					d.trigger,
					d.commitHash ? d.commitHash.slice(0, 7) : dim('n/a'),
					formatDateTime(d.createdAt),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function triggerDeploy(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(
			`${bold('Usage:')} hoststack deploy trigger <service-id> [--commit <hash>] [--branch <name>] [--clear-cache]`,
		);
		process.exit(1);
	}

	const clearCache = args.includes('--clear-cache');
	const commitIdx = args.indexOf('--commit');
	const commitHash = commitIdx !== -1 ? args[commitIdx + 1] : undefined;
	const branchIdx = args.indexOf('--branch');
	const branch = branchIdx !== -1 ? args[branchIdx + 1] : undefined;

	const s = spinner('Triggering deploy...');

	try {
		// --clear-cache wipes the BuildKit layer cache before the deploy
		// runs. The deploy endpoint itself doesn't accept a clearCache
		// flag (audit v91 #1) — it's a separate route.
		if (clearCache) {
			await apiFetch(`/api/services/${teamId}/${serviceId}/build-cache`, {
				method: 'DELETE',
			});
		}

		const body: Record<string, unknown> = {};
		if (commitHash) body.commitHash = commitHash;
		if (branch) body.branch = branch;

		const result = await apiFetch<{ deploy: Deploy }>(
			`/api/services/${teamId}/${serviceId}/deploys`,
			{
				method: 'POST',
				body: JSON.stringify(body),
			},
		);
		s.stop('Deploy triggered');

		const d = result.deploy;
		console.log(`${green('+')} Deploy ${bold(d.publicId)} ${dim(`(${d.status})`)}`);
		if (clearCache) console.log(dim('  build cache cleared'));
		console.log();
		console.log(`View logs: ${cyan(`hoststack deploy logs ${serviceId} ${d.publicId}`)}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

interface DeployLogRow {
	id: number;
	level: 'debug' | 'info' | 'warn' | 'error';
	phase?: string | null;
	message: string;
	timestamp?: string | null;
	createdAt?: string | null;
}

async function deployLogs(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const deployId = args[1];
	if (!serviceId || !deployId) {
		console.log(`${bold('Usage:')} hoststack deploy logs <service-id> <deploy-id> [--json]`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ logs: DeployLogRow[]; nextAfterId: number | null }>(
			`/api/services/${teamId}/${serviceId}/deploys/${deployId}/logs`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		if (!data.logs || data.logs.length === 0) {
			console.log(dim('No logs available yet.'));
			return;
		}

		for (const row of data.logs) {
			const ts = row.timestamp ?? row.createdAt;
			const tsStr = ts ? dim(new Date(ts).toISOString().slice(11, 19)) : dim('--:--:--');
			const level =
				row.level === 'error'
					? red('ERR ')
					: row.level === 'warn'
						? red('WARN')
						: row.level === 'debug'
							? dim('DBG ')
							: dim('INFO');
			const phase = row.phase ? dim(`[${row.phase}]`) : '';
			console.log(`${tsStr} ${level} ${phase} ${row.message}`);
		}
	} catch (err) {
		handleError(err);
	}
}

async function cancelDeploy(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const deployId = args[1];
	if (!serviceId || !deployId) {
		console.log(`${bold('Usage:')} hoststack deploy cancel <service-id> <deploy-id>`);
		process.exit(1);
	}

	const s = spinner('Cancelling deploy...');

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/deploys/${deployId}/cancel`, {
			method: 'POST',
		});
		s.stop('Deploy cancelled');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function rollbackDeploy(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const deployId = args[1];
	if (!serviceId || !deployId) {
		console.log(`${bold('Usage:')} hoststack deploy rollback <service-id> <deploy-id>`);
		process.exit(1);
	}

	const s = spinner('Rolling back...');

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/deploys/${deployId}/rollback`, {
			method: 'POST',
		});
		s.stop('Rollback initiated');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/**
 * Everything about one deploy, in one command.
 *
 * A deploy fails in three different places — the build, the container start,
 * the health check — and the evidence for each lives behind a different
 * endpoint. Working that out from a terminal meant `deploy logs` for the build
 * output, then `logs <service>` for the runtime, then remembering to bound the
 * second by the first one's start time so you were not reading yesterday.
 *
 * The runtime tail is skipped when the deploy never reached a container: for a
 * build-time failure it would show the PREVIOUS release's output, which reads
 * exactly like the new one working.
 */
async function diagnoseDeploy(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const deployId = args[1];
	if (!serviceId || !deployId) {
		console.log(
			`${bold('Usage:')} hoststack deploy diagnose <service-id> <deploy-id> [--build-lines N] [--runtime-lines N] [--json]`,
		);
		console.log();
		console.log(dim('  Deploy record + build log tail + runtime log tail since it started.'));
		console.log(dim('  --runtime-lines 0 skips the runtime half (pure build failures).'));
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');
	const buildLines = intArg(args, '--build-lines', 200);
	const runtimeLines = intArg(args, '--runtime-lines', 100);

	try {
		// The build logs do not depend on the deploy record, so fetch both at
		// once. The runtime tail does — it is bounded by the deploy's own
		// start time — so it waits.
		const [deployResp, buildResp] = await Promise.all([
			apiFetch<{
				deploy: Deploy & { startedAt?: string | null; errorMessage?: string | null };
			}>(`/api/services/${teamId}/${serviceId}/deploys/${deployId}`),
			apiFetch<{ logs: DeployLogRow[] }>(
				`/api/services/${teamId}/${serviceId}/deploys/${deployId}/logs?limit=${buildLines}`,
			),
		]);

		const deploy = deployResp.deploy;
		const buildLogs = buildResp.logs ?? [];
		// `pending` and `building` never started a container, so there is no
		// runtime output belonging to this deploy.
		const hadContainer = deploy.status !== 'pending' && deploy.status !== 'building';
		let runtime: { logs: string; lineCount: number; since: string | null } | null = null;

		if (runtimeLines > 0 && hadContainer) {
			const since = deploy.startedAt ?? undefined;
			const params = new URLSearchParams({ lines: String(runtimeLines) });
			if (since) params.set('since', since);
			const runtimeResp = await apiFetch<{
				logs: string | Array<{ timestamp?: string; level?: string; message?: string }>;
			}>(`/api/services/${teamId}/${serviceId}/runtime-logs?${params.toString()}`);
			// The route answers with either structured entries or one blob,
			// depending on the driver behind it. Both shapes have shipped.
			const entries = Array.isArray(runtimeResp.logs)
				? runtimeResp.logs.map((e) => String(e.message ?? ''))
				: typeof runtimeResp.logs === 'string'
					? runtimeResp.logs.split('\n')
					: [];
			runtime = {
				logs: entries.join('\n'),
				lineCount: entries.length,
				since: since ?? null,
			};
		}

		if (jsonFlag) {
			console.log(
				JSON.stringify(
					{
						deploy,
						build: { lineCount: buildLogs.length, logs: buildLogs },
						runtime,
					},
					null,
					2,
				),
			);
			return;
		}

		console.log(
			`${bold(deploy.publicId)} ${statusBadge(deploy.status)} ${dim(`· ${deploy.trigger} · ${formatDateTime(deploy.createdAt)}`)}`,
		);
		if (deploy.commitHash) {
			console.log(
				`${dim('commit')} ${deploy.commitHash.slice(0, 7)}${deploy.commitMessage ? ` ${dim(deploy.commitMessage.split('\n')[0] ?? '')}` : ''}`,
			);
		}
		if (deploy.errorMessage) {
			console.log(`${red('error')} ${deploy.errorMessage}`);
		}

		console.log();
		console.log(bold(`Build log (last ${buildLogs.length} lines)`));
		if (buildLogs.length === 0) {
			console.log(dim('  nothing logged'));
		} else {
			for (const row of buildLogs) printLogRow(row);
		}

		console.log();
		if (!hadContainer) {
			console.log(bold('Runtime log'));
			// Said explicitly. An empty section here would otherwise read as
			// "the container started and printed nothing", which is a
			// completely different fault.
			console.log(
				dim(`  skipped — this deploy never started a container (status ${deploy.status})`),
			);
		} else if (runtime === null) {
			console.log(bold('Runtime log'));
			console.log(dim('  skipped (--runtime-lines 0)'));
		} else {
			console.log(
				bold(`Runtime log (${runtime.lineCount} lines`) +
					bold(runtime.since ? `, since ${formatDateTime(runtime.since)})` : ')'),
			);
			console.log(runtime.logs.length > 0 ? runtime.logs : dim('  nothing logged'));
		}
	} catch (err) {
		handleError(err);
	}
}

function printLogRow(row: DeployLogRow): void {
	const ts = row.timestamp ?? row.createdAt;
	const tsStr = ts ? dim(new Date(ts).toISOString().slice(11, 19)) : dim('--:--:--');
	const level =
		row.level === 'error'
			? red('ERR ')
			: row.level === 'warn'
				? red('WARN')
				: row.level === 'debug'
					? dim('DBG ')
					: dim('INFO');
	const phase = row.phase ? dim(`[${row.phase}]`) : '';
	console.log(`${tsStr} ${level} ${phase} ${row.message}`);
}

function intArg(args: string[], name: string, fallback: number): number {
	const i = args.indexOf(name);
	if (i === -1) return fallback;
	const raw = args[i + 1];
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < 0) {
		console.error(red(`${name} needs a whole number, got "${raw}"`));
		process.exit(1);
	}
	return n;
}

/**
 * Build once, run many: send a deploy's ALREADY-BUILT image to a sibling
 * service in another environment. No rebuild, so what runs in production is
 * byte-for-byte what was tested in staging.
 *
 * If no sibling exists in the target env yet, the API clones the source
 * service's build/runtime config into it first. What it does NOT copy is
 * per-environment by design — env vars, secret files, volumes, IP allowlists,
 * custom domains — so a freshly promoted service starts with none of the
 * source's configuration, and that is the thing to check before calling it
 * live.
 */
async function promoteDeploy(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const deployId = args[1];
	const envIdx = args.indexOf('--to');
	const envRef = envIdx !== -1 ? args[envIdx + 1] : undefined;

	if (!serviceId || !deployId || !envRef) {
		console.log(
			`${bold('Usage:')} hoststack deploy promote <service-id> <deploy-id> --to <env-id|env_…>`,
		);
		console.log();
		console.log(dim('  Runs the deploy’s existing image on the sibling service in the'));
		console.log(dim('  target environment. No rebuild, so it is the same bytes you tested.'));
		console.log();
		console.log(dim('  Env vars, secret files, volumes, IP allowlists and domains are NOT'));
		console.log(dim('  copied — they are per-environment. Check them before calling it live.'));
		console.log();
		console.log(dim('  Environment ids: hoststack environments list <project-id>'));
		process.exit(1);
	}

	const targetEnvironmentId = await resolveEnvironmentId(teamId, envRef);

	const s = spinner('Promoting...');
	try {
		const { deploy } = await apiFetch<{ deploy: Deploy }>(
			`/api/services/${teamId}/${serviceId}/deploys/${deployId}/promote`,
			{ method: 'POST', body: JSON.stringify({ targetEnvironmentId }) },
		);
		s.stop('Promoted');
		console.log(`${green('+')} Deploy ${bold(deploy.publicId)} ${dim(`(${deploy.status})`)}`);
		console.log();
		console.log(dim('Env vars, secret files, volumes and domains did not come with it.'));
		console.log(
			`Watch it: ${cyan(`hoststack deploy logs <target-service-id> ${deploy.publicId}`)}`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
