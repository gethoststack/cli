import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, table } from '../lib/output.ts';
import { resolveProjectId } from '../lib/resolve.ts';

interface Environment {
	id: number;
	publicId: string;
	projectId: number;
	name: string;
	type: 'production' | 'staging' | 'development' | 'preview';
	isDefault: boolean;
	isProtected: boolean;
	createdAt: string;
}

/**
 * v66 P5: manage project environments. Each project has at least
 * Production (auto-created); add staging/dev/preview envs to run
 * sibling services side-by-side and promote builds between them.
 *
 * Aliased to `env` is intentionally avoided — the existing `env`
 * command manages env vars on a service. Use `environments` (or
 * `envs`) for environments.
 */
export async function environmentsCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listEnvironments(args.slice(1));
		case 'create':
		case 'new':
			return createEnvironment(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteEnvironment(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack environments <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list <project-id>                          List envs for a project');
			console.log('  create <project-id> --name <n> --type <t>  Create an environment');
			console.log('  delete <project-id> <env-id>               Delete an environment');
			console.log();
			console.log('Types: production | staging | development | preview');
			process.exit(1);
	}
}

async function listEnvironments(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const projectArg = args[0];
	if (!projectArg) {
		console.log(`${bold('Usage:')} hoststack environments list <project-id>`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		// Accept either a numeric id or the `prj_…` publicId that `hoststack
		// projects` prints (the API route is keyed on the numeric id).
		const projectId = await resolveProjectId(teamId, projectArg);
		const data = await apiFetch<{ environments: Environment[] }>(
			`/api/environments/${teamId}/${projectId}`,
		);
		const envs = data.environments;

		if (jsonFlag) {
			console.log(JSON.stringify(envs, null, 2));
			return;
		}

		if (envs.length === 0) {
			console.log(dim('No environments found.'));
			return;
		}

		console.log(
			table(
				['ID', 'Name', 'Type', 'Default', 'Protected'],
				envs.map((e) => [
					e.publicId,
					e.name,
					e.type,
					e.isDefault ? '✓' : '',
					e.isProtected ? '✓' : '',
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function createEnvironment(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const projectId = args[0];
	if (!projectId || projectId.startsWith('--')) {
		console.log(
			`${bold('Usage:')} hoststack environments create <project-id> --name <name> --type <type>`,
		);
		console.log('Types: production | staging | development | preview');
		process.exit(1);
	}

	const nameIdx = args.indexOf('--name');
	const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
	const typeIdx = args.indexOf('--type');
	const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
	const protectedFlag = args.includes('--protected');

	if (!name || !type) {
		console.log(
			`${bold('Usage:')} hoststack environments create <project-id> --name <name> --type <type>`,
		);
		console.log('Types: production | staging | development | preview');
		process.exit(1);
	}
	if (!['production', 'staging', 'development', 'preview'].includes(type)) {
		console.error(
			red(`Invalid type "${type}". Use production | staging | development | preview.`),
		);
		process.exit(1);
	}

	const s = spinner('Creating environment...');

	try {
		const res = await apiFetch<{ environment: Environment }>(
			`/api/environments/${teamId}/${projectId}`,
			{
				method: 'POST',
				body: JSON.stringify({ name, type, isProtected: protectedFlag }),
			},
		);
		s.stop('Environment created');
		console.log(
			`${green('+')} ${bold(res.environment.name)} ${dim(`(${res.environment.publicId}, ${res.environment.type})`)}`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteEnvironment(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const projectId = args[0];
	const envId = args[1];
	if (!projectId || !envId) {
		console.log(`${bold('Usage:')} hoststack environments delete <project-id> <env-id>`);
		process.exit(1);
	}

	const s = spinner('Deleting environment...');

	try {
		await apiFetch(`/api/environments/${teamId}/${projectId}/${envId}`, {
			method: 'DELETE',
		});
		s.stop('Environment deleted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
