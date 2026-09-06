import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
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
					new Date(d.createdAt).toLocaleString(),
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
