import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, table } from '../lib/output.ts';

interface EnvVar {
	id: number;
	publicId?: string;
	key: string;
	value: string;
	isSecret: boolean;
}

export async function envCommand(args: string[]): Promise<void> {
	const subcommand = args[0];

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listEnvVars(args.slice(1));
		case 'set':
			return setEnvVar(args.slice(1));
		case 'get':
			return getEnvVar(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteEnvVar(args.slice(1));
		case 'bulk':
			return bulkSetEnvVars(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack env <command> <service-id>`);
			console.log();
			console.log('Commands:');
			console.log('  list <service-id>                     List environment variables');
			console.log('  get <service-id> <KEY>                Get a single variable');
			console.log('  set <service-id> KEY=VALUE            Set an environment variable');
			console.log('  delete <service-id> <env-var-id>      Delete an environment variable');
			console.log('  bulk <service-id> KEY1=VAL1 KEY2=VAL2 Set multiple variables at once');
			process.exit(1);
	}
}

async function listEnvVars(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack env list <service-id>`);
		process.exit(1);
	}

	try {
		const data = await apiFetch<{ envVars: EnvVar[] }>(
			`/api/services/${teamId}/${serviceId}/env`,
		);
		const vars = data.envVars;

		if (vars.length === 0) {
			console.log(dim('No environment variables set.'));
			return;
		}

		console.log(
			table(
				['Key', 'Value', 'Secret'],
				vars.map((v) => [
					v.key,
					v.isSecret ? dim('********') : v.value,
					v.isSecret ? 'yes' : 'no',
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function getEnvVar(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const key = args[1];
	if (!serviceId || !key) {
		console.log(`${bold('Usage:')} hoststack env get <service-id> <KEY>`);
		process.exit(1);
	}

	try {
		const data = await apiFetch<{ envVars: EnvVar[] }>(
			`/api/services/${teamId}/${serviceId}/env`,
		);
		const found = data.envVars.find((v) => v.key === key);

		if (!found) {
			console.error(red(`Variable "${key}" not found.`));
			process.exit(1);
		}

		if (found.isSecret) {
			console.log(`${bold(found.key)}=${dim('********')} ${dim('(secret)')}`);
		} else {
			console.log(`${bold(found.key)}=${found.value}`);
		}
	} catch (err) {
		handleError(err);
	}
}

async function setEnvVar(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const pair = args[1];
	if (!serviceId || !pair || !pair.includes('=')) {
		console.log(`${bold('Usage:')} hoststack env set <service-id> KEY=VALUE [--secret]`);
		process.exit(1);
	}

	const eqIdx = pair.indexOf('=');
	const key = pair.slice(0, eqIdx);
	const value = pair.slice(eqIdx + 1);
	const isSecret = args.includes('--secret');

	const s = spinner(`Setting ${key}...`);

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/env`, {
			method: 'POST',
			body: JSON.stringify({ key, value, isSecret }),
		});
		s.stop(`${green('+')} ${bold(key)} set`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteEnvVar(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const envVarId = args[1];
	if (!serviceId || !envVarId) {
		console.log(`${bold('Usage:')} hoststack env delete <service-id> <env-var-id>`);
		process.exit(1);
	}

	const s = spinner('Deleting variable...');

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/env/${envVarId}`, {
			method: 'DELETE',
		});
		s.stop('Variable deleted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function bulkSetEnvVars(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const pairs = args.slice(1).filter((a) => a.includes('='));

	if (!serviceId || pairs.length === 0) {
		console.log(`${bold('Usage:')} hoststack env bulk <service-id> KEY1=VAL1 KEY2=VAL2 ...`);
		process.exit(1);
	}

	const envVars = pairs.map((pair) => {
		const eqIdx = pair.indexOf('=');
		return {
			key: pair.slice(0, eqIdx),
			value: pair.slice(eqIdx + 1),
		};
	});

	const s = spinner(`Setting ${envVars.length} variable(s)...`);

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/env/bulk`, {
			method: 'PUT',
			body: JSON.stringify({ envVars }),
		});
		s.stop(`${green('+')} ${envVars.length} variable(s) set`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
