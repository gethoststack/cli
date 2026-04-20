import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, statusBadge, table } from '../lib/output.ts';

interface CronExecution {
	id: number;
	publicId: string;
	status: string;
	startedAt?: string | null;
	finishedAt?: string | null;
	exitCode?: number | null;
	triggeredBy?: string | null;
	createdAt: string;
}

export async function cronCommand(args: string[]): Promise<void> {
	const subcommand = args[0];

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listExecutions(args.slice(1));
		case 'get':
		case 'info':
			return getExecution(args.slice(1));
		case 'trigger':
		case 'run':
			return triggerExecution(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack cron <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list <service-id>              List cron executions for a service');
			console.log('  get <service-id> <exec-id>     Get a cron execution');
			console.log('  trigger <service-id>           Trigger an immediate cron execution');
			process.exit(1);
	}
}

async function listExecutions(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack cron list <service-id> [--limit <n>]`);
		process.exit(1);
	}

	const limitIdx = args.indexOf('--limit');
	const limit = limitIdx !== -1 ? args[limitIdx + 1] : undefined;

	const jsonFlag = args.includes('--json');

	try {
		const params = new URLSearchParams();
		if (limit) params.set('limit', limit);
		const qs = params.toString();
		const data = await apiFetch<{ executions: CronExecution[] }>(
			`/api/services/${teamId}/${serviceId}/cron-executions${qs ? `?${qs}` : ''}`,
		);
		const executions = data.executions;

		if (jsonFlag) {
			console.log(JSON.stringify(executions, null, 2));
			return;
		}

		if (executions.length === 0) {
			console.log(dim('No cron executions found.'));
			return;
		}

		console.log(
			table(
				['ID', 'Status', 'Exit Code', 'Started', 'Finished'],
				executions.map((e) => [
					e.publicId,
					statusBadge(e.status),
					e.exitCode !== null && e.exitCode !== undefined ? String(e.exitCode) : dim('n/a'),
					e.startedAt ? new Date(e.startedAt).toLocaleString() : dim('n/a'),
					e.finishedAt ? new Date(e.finishedAt).toLocaleString() : dim('n/a'),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function getExecution(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const execId = args[1];
	if (!serviceId || !execId) {
		console.log(`${bold('Usage:')} hoststack cron get <service-id> <execution-id>`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ execution: CronExecution }>(
			`/api/services/${teamId}/${serviceId}/cron-executions/${execId}`,
		);
		const e = data.execution;

		if (jsonFlag) {
			console.log(JSON.stringify(e, null, 2));
			return;
		}

		console.log(`${bold('ID:')}          ${e.publicId}`);
		console.log(`${bold('Status:')}      ${statusBadge(e.status)}`);
		if (e.exitCode !== null && e.exitCode !== undefined) {
			console.log(`${bold('Exit Code:')}   ${e.exitCode}`);
		}
		if (e.triggeredBy) {
			console.log(`${bold('Triggered:')}   ${e.triggeredBy}`);
		}
		console.log(`${bold('Started:')}     ${e.startedAt ? new Date(e.startedAt).toLocaleString() : dim('n/a')}`);
		console.log(`${bold('Finished:')}    ${e.finishedAt ? new Date(e.finishedAt).toLocaleString() : dim('n/a')}`);
		console.log(`${bold('Created:')}     ${new Date(e.createdAt).toLocaleString()}`);
	} catch (err) {
		handleError(err);
	}
}

async function triggerExecution(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack cron trigger <service-id>`);
		process.exit(1);
	}

	const s = spinner('Triggering cron execution...');

	try {
		const result = await apiFetch<{ execution: CronExecution }>(
			`/api/services/${teamId}/${serviceId}/cron-executions/trigger`,
			{ method: 'POST' },
		);
		s.stop('Cron execution triggered');
		console.log(`${green('+')} Execution ${bold(result.execution.publicId)} ${dim(`(${result.execution.status})`)}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
