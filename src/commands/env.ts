import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, table } from '../lib/output.ts';

interface EnvVar {
	id: number;
	publicId?: string;
	key: string;
	value: string;
	isSecret: boolean;
	target?: 'build' | 'runtime' | 'both';
}

const ENV_TARGETS = ['build', 'runtime', 'both'] as const;
type EnvTarget = (typeof ENV_TARGETS)[number];

/** Read a `--flag value` or `--flag=value` option out of an argv slice. */
function getFlagValue(args: string[], flag: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === flag) return args[i + 1];
		if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
	}
	return undefined;
}

/**
 * Resolve the `isSecret` intent from flags. `--secret` → true, `--no-secret`
 * → false, neither → undefined (leave existing classification untouched on
 * update; default to non-secret on create).
 */
function parseSecretFlag(args: string[]): boolean | undefined {
	if (args.includes('--no-secret')) return false;
	if (args.includes('--secret')) return true;
	return undefined;
}

function parseTargetFlag(args: string[]): EnvTarget | undefined {
	const raw = getFlagValue(args, '--target');
	if (raw === undefined) return undefined;
	if (!ENV_TARGETS.includes(raw as EnvTarget)) {
		console.error(red(`Invalid --target "${raw}". Use one of: ${ENV_TARGETS.join(', ')}.`));
		process.exit(1);
	}
	return raw as EnvTarget;
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
			console.log('  set <service-id> KEY=VALUE            Create or update a variable');
			console.log('  delete <service-id> <KEY|env-var-id>  Delete an environment variable');
			console.log('  bulk <service-id> KEY1=VAL1 KEY2=VAL2 Replace all variables at once');
			console.log();
			console.log('Flags (set):');
			console.log('  --secret            Mark the variable as secret (encrypted, masked)');
			console.log('  --no-secret         Mark the variable as non-secret');
			console.log('  --target <t>        Inject into: build | runtime | both (default both)');
			console.log('                      A secret on "both" is runtime-only — build args');
			console.log(
				'                      are baked into image history. Use "build" to force.',
			);
			console.log();
			console.log('Flags (bulk):');
			console.log('  --secret            Mark every variable as secret');
			console.log('  --target <t>        Inject target for every variable (default both)');
			console.log('                      Secrets on "both" stay runtime-only; use "build".');
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
		console.log(`${bold('Usage:')} hoststack env list <service-id> [--json]`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ envVars: EnvVar[] }>(
			`/api/services/${teamId}/${serviceId}/env`,
		);
		const vars = data.envVars;

		if (jsonFlag) {
			console.log(JSON.stringify(vars, null, 2));
			return;
		}

		if (vars.length === 0) {
			console.log(dim('No environment variables set.'));
			return;
		}

		console.log(
			table(
				['ID', 'Key', 'Value', 'Secret'],
				vars.map((v) => [
					String(v.id),
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
		console.log(
			`${bold('Usage:')} hoststack env set <service-id> KEY=VALUE [--secret|--no-secret] [--target <t>]`,
		);
		process.exit(1);
	}

	const eqIdx = pair.indexOf('=');
	const key = pair.slice(0, eqIdx);
	const value = pair.slice(eqIdx + 1);
	const secretFlag = parseSecretFlag(args.slice(2));
	const targetFlag = parseTargetFlag(args.slice(2));

	const s = spinner(`Setting ${key}...`);

	try {
		// Upsert: the API enforces a unique (service, key) pair, so a blind
		// POST on an existing key fails. Look the key up first and PATCH it
		// when present, mirroring the MCP/dashboard behaviour.
		const existing = await apiFetch<{ envVars: EnvVar[] }>(
			`/api/services/${teamId}/${serviceId}/env`,
		);
		const match = existing.envVars.find((v) => v.key === key);

		if (match) {
			const body: { value: string; isSecret?: boolean; target?: EnvTarget } = { value };
			// Only forward isSecret when the user asked, so a plain value
			// change does not silently flip an existing var's classification.
			if (secretFlag !== undefined) body.isSecret = secretFlag;
			if (targetFlag !== undefined) body.target = targetFlag;
			await apiFetch(`/api/services/${teamId}/${serviceId}/env/${match.id}`, {
				method: 'PATCH',
				body: JSON.stringify(body),
			});
			s.stop(`${green('~')} ${bold(key)} updated`);
		} else {
			await apiFetch(`/api/services/${teamId}/${serviceId}/env`, {
				method: 'POST',
				body: JSON.stringify({
					key,
					value,
					isSecret: secretFlag ?? false,
					target: targetFlag ?? 'both',
				}),
			});
			s.stop(`${green('+')} ${bold(key)} set`);
		}
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
	const idOrKey = args[1];
	if (!serviceId || !idOrKey) {
		console.log(`${bold('Usage:')} hoststack env delete <service-id> <KEY|env-var-id>`);
		process.exit(1);
	}

	// Accept either a numeric id or a KEY. Looking up by key keeps the
	// CLI usable from `env list` output (audit v91 #7) — the list shows
	// the key, not the numeric id by default.
	let envVarId: number;
	if (/^\d+$/.test(idOrKey)) {
		envVarId = Number(idOrKey);
	} else {
		const data = await apiFetch<{ envVars: EnvVar[] }>(
			`/api/services/${teamId}/${serviceId}/env`,
		);
		const found = data.envVars.find((v) => v.key === idOrKey);
		if (!found) {
			console.error(red(`Variable "${idOrKey}" not found on this service.`));
			process.exit(1);
		}
		envVarId = found.id;
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
	// Flags start with `-`; everything with an `=` is treated as a KEY=VALUE
	// pair (so values may contain `=`, e.g. base64 padding).
	const pairs = args.slice(1).filter((a) => !a.startsWith('-') && a.includes('='));
	const isSecret = parseSecretFlag(args.slice(1)) ?? false;
	const target = parseTargetFlag(args.slice(1)) ?? 'both';

	if (!serviceId || pairs.length === 0) {
		console.log(
			`${bold('Usage:')} hoststack env bulk <service-id> KEY1=VAL1 KEY2=VAL2 ... [--secret] [--target <t>]`,
		);
		process.exit(1);
	}

	const vars = pairs.map((pair) => {
		const eqIdx = pair.indexOf('=');
		return {
			key: pair.slice(0, eqIdx),
			value: pair.slice(eqIdx + 1),
			isSecret,
			target,
		};
	});

	const s = spinner(`Setting ${vars.length} variable(s)...`);

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/env/bulk`, {
			method: 'PUT',
			body: JSON.stringify({ vars }),
		});
		s.stop(`${green('+')} ${vars.length} variable(s) set`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
