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
			console.log('  trigger <service-id> [--clear-cache]   Trigger a new deploy');
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
		const data = await apiFetch<{ deploys: Deploy[] }>(
			`/api/services/${teamId}/${serviceId}/deploys`,
		);
		const deploys = data.deploys;

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
		console.log(`${bold('Usage:')} hoststack deploy trigger <service-id> [--clear-cache]`);
		process.exit(1);
	}

	const clearCache = args.includes('--clear-cache');
	const s = spinner('Triggering deploy...');

	try {
		const result = await apiFetch<{ deploy: Deploy }>(
			`/api/services/${teamId}/${serviceId}/deploys`,
			{
				method: 'POST',
				body: JSON.stringify({ clearCache }),
			},
		);
		s.stop('Deploy triggered');

		const d = result.deploy;
		console.log(`${green('+')} Deploy ${bold(d.publicId)} ${dim(`(${d.status})`)}`);
		console.log();
		console.log(`View logs: ${cyan(`hoststack deploy logs ${serviceId} ${d.publicId}`)}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
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
		console.log(`${bold('Usage:')} hoststack deploy logs <service-id> <deploy-id>`);
		process.exit(1);
	}

	try {
		const data = await apiFetch<{ logs: string }>(
			`/api/services/${teamId}/${serviceId}/deploys/${deployId}/logs`,
		);
		if (data.logs) {
			console.log(data.logs);
		} else {
			console.log(dim('No logs available yet.'));
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
