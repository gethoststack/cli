import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, cyan, dim, green, handleError, red, spinner } from '../lib/output.ts';
import { resolveProjectId, resolveServiceId } from '../lib/resolve.ts';
import { machineIdFromFlag } from './machines.ts';

// Keep in sync with packages/shared/src/constants/dev-env.ts (DEV_ENV_IMAGE)
// and packages/shared/src/constants/pricing.ts (DEV_ENV_MIN_SIZE) — NOT with
// packages/shared/src/templates.ts, which this used to name: that preset was
// deliberately removed and templates.ts now says so.
// The CLI is a standalone published package with no @hoststack/shared
// dependency, so these constants are duplicated here intentionally.
const DEV_ENV_IMAGE = 'registry.hoststack.dev/hoststack/dev-env:latest';
const DEV_ENV_VOLUME = { name: 'workspace', mountPath: '/workspace', sizeGb: 10 };
// API-key env vars that light up the baked-in HostStack / PostStack MCP
// servers inside the container. Empty unless the user passes --hoststack-key
// / --poststack-key (or generic --env rows).
const DEV_ENV_KEYS = ['HOSTSTACK_API_KEY', 'POSTSTACK_API_KEY'] as const;

interface Service {
	id: number;
	publicId: string;
	name: string;
	type: string;
	status: string;
}

export async function devCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'help';

	// Asking what a command does must never DO the command. `dev new` takes no
	// required flags — by design, so "I want a box" is one command — which means
	// `hoststack dev new --help` parsed every flag as absent, fell through to the
	// blank-box branch and provisioned a billable box plus a 10 GB volume. The
	// sibling subcommands only escape that by accident: `create` happens to
	// require --project, and `delete` happens to require a service id, so both
	// bail to usage. That is one relaxed requirement away from the same bug, so
	// the guard belongs here in the dispatcher rather than in each leaf.
	//
	// Deliberately greedy: `--name --help` prints usage instead of creating a box
	// literally named "--help". Failing toward the help text is always the safe
	// direction. Exit 0 — an explicit request for help succeeded.
	if (args.slice(1).some((a) => a === '--help' || a === '-h' || a === 'help')) {
		printUsage();
		process.exit(0);
	}

	switch (subcommand) {
		case 'new':
			return newDevEnv(args.slice(1));
		case 'list':
		case 'ls':
			return listDevEnvs();
		case 'create':
			return createDevEnv(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteDevEnv(args.slice(1));
		default:
			printUsage();
			process.exit(subcommand === 'help' ? 0 : 1);
	}
}

function printUsage(): void {
	console.log(`${bold('Usage:')} hoststack dev <command>`);
	console.log();
	console.log('Commands:');
	console.log('  new       Create a standalone dev env (GitHub repo / URL / blank + companions)');
	console.log('  list      List your dev environments and their companion services');
	console.log('  create    Spin up an AI dev environment (cloud terminal + agents)');
	console.log('  delete    Tear down a dev environment (box + cloned DB + volume)');
	console.log();
	// The one thing a newcomer looks for here and does not find. There is no
	// `dev shell`/`exec`/`open`, and no sshd in the image, so saying where the
	// terminal actually lives is more use than letting them keep looking.
	console.log(`${bold('Opening a box:')} the terminal lives in the dashboard —`);
	console.log('  Development -> pick the box -> Terminal (works from a phone).');
	console.log('  There is no `dev shell` / `dev exec`, and no SSH server in a box.');
	console.log();
	console.log(`${bold('New vs create:')}`);
	console.log('  new     standalone box in the team Development section (the dashboard flow)');
	console.log(
		'  create  a box inside a PROJECT (--project), or a clone of a service (--service)',
	);
	console.log();
	console.log(`${bold('hoststack dev new')} options:`);
	console.log('  --name <name>          Dev box name (optional — derived from the source)');
	console.log('  --github-id <n>        Clone a connected GitHub repo by id');
	console.log('  --repo <git-url>       Clone any http(s) git URL (instead of --github-id)');
	console.log('  --branch <name>        Branch to clone');
	console.log('  --db <csv>             Companion services: postgres,redis,meilisearch');
	console.log('  --plan <size>          Box size (default: standard — smaller is raised to it)');
	console.log('  --machine <name|id>    Run it on your own machine (hoststack machines list)');
	console.log('  (omit --github-id/--repo for a blank box)');
	console.log();
	console.log(`${bold('hoststack dev create')} options:`);
	console.log('  Bare box (default):');
	console.log('  --project <id|prj_…>   Project to create it in (required for a bare box)');
	console.log('  --name <name>          Service name (default: dev-environment)');
	console.log('  --size <plan>          Box size (default: standard — smaller is raised to it)');
	console.log('  --disk <GB>            Workspace volume size in GB (default: 10)');
	// An ordering that can actually happen. There is no "put a key there first":
	// /workspace is a fresh volume created WITH the box
	// (apps/api/src/services/dev-environment.service.ts:95) and its .ssh dir is
	// made empty by the entrypoint on that same first boot
	// (apps/dev-env-image/Dockerfile), which is also when the clone runs
	// (Dockerfile). What IS true: the in-box credential helper is
	// scoped to github.com and mints a token from the team's GitHub App
	// installation (Dockerfile → apps/api/src/routes/internal.ts:296 →
	// dev-environment.service.ts:1731-1735), so public URLs and connected-GitHub
	// repos need nothing. A failed clone is non-fatal — the entrypoint logs
	// "clone it manually from the terminal" and the box still comes up
	// (Dockerfile) — and it retries on every later boot while the
	// repo is absent (Dockerfile `if [ ! -d "$target/.git" ]`).
	console.log('  --repo <git-url>       Clone this repo into /workspace on first boot');
	console.log('                         (public URLs and your connected GitHub repos need no');
	console.log('                          key; anything else fails this first clone — the box');
	console.log('                          still boots, so add your key from its terminal and');
	console.log('                          clone there)');
	console.log('  --branch <name>        Branch to clone (with --repo)');
	console.log('  --hoststack-key <key>  Set HOSTSTACK_API_KEY (enables the hoststack MCP)');
	console.log('  --poststack-key <key>  Set POSTSTACK_API_KEY (enables the poststack MCP)');
	console.log('  --env KEY=VALUE        Set an extra env var (repeatable)');
	console.log('  --machine <name|id>    Run it on your own machine (hoststack machines list)');
	console.log('  --no-deploy            Create + configure but skip the first deploy');
	console.log();
	console.log('  From an existing service (runs a clone of the app):');
	console.log('  --service <id|svc_…>   Spin up a dev box FROM this service');
	console.log('  --no-db                Skip cloning the linked database');
	console.log('  --name <name>          Dev box name (default: <service>-dev)');
	console.log('  --machine <name|id>    Run it on your own machine (default: wherever the');
	console.log('                          source service runs)');
	console.log();
	console.log(`${bold('hoststack dev delete')} <id|svc_…>`);
	console.log('  Removes the dev box, its cloned database, and /workspace volume.');
	console.log();
	// --db attaches SEPARATE managed databases. Without this note the flag reads
	// as the only way to get a database at all, and the answer to "I need MySQL"
	// becomes a managed instance (or a `docker run` that cannot work — there is
	// no daemon in a box) when the box already had one a command away.
	console.log(`${bold('Inside every box')} (no Docker daemon — it is all preinstalled):`);
	console.log('  dev-services up             Postgres :5432 · Redis :6379 · Meilisearch :7700');
	console.log('  dev-services up mysql       MariaDB :3306 (WordPress, Laravel, Rails)');
	console.log('  dev-services up mongodb     MongoDB :27017');
	console.log('  dev-services createdb <db>  Postgres role + database, so an app .env connects');
	console.log('  dev-runtime add <name>      go · java · ruby · rust · erlang · elixir · dotnet');
	console.log('                              (node, bun, python, php are already there)');
	console.log('  hoststack-status            What is running, the dev URL, agent login state');
	console.log();
	console.log('  --db attaches SEPARATE managed databases; the above run inside the box.');
	console.log(
		'  Link a database you ALREADY have instead: hoststack db link <db> --service <box>',
	);
	console.log();
	console.log('Examples:');
	console.log('  hoststack dev new --name app-dev --github-id 42 --db postgres,redis');
	console.log('  hoststack dev new --name scratch                  # blank box');
	console.log('  hoststack dev list');
	console.log('  hoststack dev create --project prj_abc');
	console.log('  hoststack dev create --project prj_abc --repo https://github.com/me/app.git');
	console.log('  hoststack dev create --service svc_abc            # clone of an app + dev URL');
	console.log('  hoststack dev create --service svc_abc --no-db');
	console.log('  hoststack dev delete svc_dev');
	console.log();
	console.log(`${bold('On more than one team?')} There is no --team flag and no teams command;`);
	console.log('  set HOSTSTACK_TEAM_ID=<id> to choose which team these commands act on.');
	console.log();
	console.log(`${dim('Docs: https://hoststack.dev/docs/dev-environments')}`);
	console.log(
		`${dim('Moving an existing project in: https://hoststack.dev/docs/dev-environments-migrate')}`,
	);
}

function flagValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx !== -1 ? args[idx + 1] : undefined;
}

async function createDevEnv(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	// --service spins up a dev box FROM an existing service: a clone of the app
	// (repo + env-vars + cloned DB) with a public dev URL. Distinct from the
	// bare-box flow below, which builds an empty agent sandbox from scratch.
	const serviceRaw = flagValue(args, '--service');
	if (serviceRaw) {
		return spinUpFromService(teamId, serviceRaw, args);
	}

	const projectRaw = flagValue(args, '--project');
	if (!projectRaw) {
		printUsage();
		process.exit(1);
	}

	const name = flagValue(args, '--name') ?? 'dev-environment';
	// `standard`, not `micro`: the API floors any dev-env plan to the OOM-safe
	// minimum (coerceDevEnvSize) because a coding agent plus a build does not
	// fit below 2 GB. Sending `micro` was not wrong — it was silently raised
	// server-side — but it made the CLI advertise a size and a price the user
	// would never actually get. Ask for what we will be given.
	const plan = flagValue(args, '--size') ?? 'standard';
	const diskRaw = flagValue(args, '--disk');
	const sizeGb = diskRaw ? Number.parseInt(diskRaw, 10) : DEV_ENV_VOLUME.sizeGb;
	// Hetzner block-volume bounds (see HETZNER_BLOCK_VOLUME_MIN/MAX_GB in
	// packages/shared/src/constants/pricing.ts) — the API rejects anything
	// outside [10, 10240].
	if (Number.isNaN(sizeGb) || sizeGb < 10 || sizeGb > 10240) {
		console.error(red('--disk must be an integer between 10 and 10240'));
		process.exit(1);
	}
	const noDeploy = args.includes('--no-deploy');

	// Collect env vars: the two MCP-key convenience flags + any repeatable
	// --env KEY=VALUE rows.
	const envVars: { key: string; value: string; isSecret: boolean }[] = [];
	const hoststackKey = flagValue(args, '--hoststack-key');
	if (hoststackKey) envVars.push({ key: DEV_ENV_KEYS[0], value: hoststackKey, isSecret: true });
	const poststackKey = flagValue(args, '--poststack-key');
	if (poststackKey) envVars.push({ key: DEV_ENV_KEYS[1], value: poststackKey, isSecret: true });
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === '--env') {
			const pair = args[i + 1];
			if (!pair || !pair.includes('=')) {
				console.error(red('--env expects KEY=VALUE'));
				process.exit(1);
			}
			const eq = pair.indexOf('=');
			const key = pair.slice(0, eq);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				console.error(
					red(
						`Invalid env key "${key}". Use letters, digits and underscores, not starting with a digit.`,
					),
				);
				process.exit(1);
			}
			envVars.push({ key, value: pair.slice(eq + 1), isSecret: true });
		}
	}

	// --repo clones an arbitrary git URL into /workspace on first boot (the image
	// entrypoint reads HOSTSTACK_DEVENV_REPO_URL). Public/HTTPS repos clone right
	// away, as do repos on the team's connected GitHub (the in-box credential
	// helper mints an installation token — dev-environment.service.ts:1731-1735).
	// Private SSH repos (git@github.com:…) need a key in /workspace/.ssh, and the
	// only way to put one there today is the box's own terminal: the Shared setup
	// panel renders no ssh_key form (apps/web/src/components/app/development/setup/
	// has git-identity-form.tsx only; shared/shared-setup-panel.tsx is the sole
	// `provision` consumer), even though the route and service write-path exist.
	const repoUrl = flagValue(args, '--repo');
	if (repoUrl) {
		envVars.push({ key: 'HOSTSTACK_DEVENV_REPO_URL', value: repoUrl, isSecret: false });
		const branch = flagValue(args, '--branch');
		if (branch) {
			envVars.push({ key: 'HOSTSTACK_DEVENV_BRANCH', value: branch, isSecret: false });
		}
	}

	const projectId = await resolveProjectId(teamId, projectRaw);
	// Resolved before anything is created: an unknown machine name should cost
	// one error message, not a created-then-abandoned box.
	const machineId = await machineIdFromFlag(args, teamId);

	// Mirror the dashboard wizard's orchestration so the first container boots
	// WITH its volume + keys in place (use-new-service-form.ts): create with
	// autoDeploy:false → set env → attach /workspace → fire the first deploy.
	const createSpinner = spinner(`Creating dev environment "${name}"...`);
	let service: Service;
	try {
		const result = await apiFetch<{ service: Service }>(`/api/services/${teamId}`, {
			method: 'POST',
			body: JSON.stringify({
				name,
				type: 'private_service',
				projectId,
				dockerImage: DEV_ENV_IMAGE,
				plan,
				autoDeploy: false,
				...(machineId !== undefined ? { machineId } : {}),
			}),
		});
		service = result.service;
		createSpinner.stop(`Created ${bold(service.name)} ${dim(`(${service.publicId})`)}`);
	} catch (err) {
		createSpinner.stop(red('Failed'));
		return handleError(err);
	}

	if (envVars.length > 0) {
		const envSpinner = spinner(`Setting ${envVars.length} environment variable(s)...`);
		try {
			await apiFetch(`/api/services/${teamId}/${service.id}/env/bulk`, {
				method: 'PUT',
				body: JSON.stringify({ vars: envVars }),
			});
			envSpinner.stop(`${green('+')} ${envVars.length} variable(s) set`);
		} catch (err) {
			envSpinner.stop(red('Failed to set env vars'));
			return handleError(err);
		}
	}

	const volSpinner = spinner(`Attaching ${sizeGb}GB workspace at ${DEV_ENV_VOLUME.mountPath}...`);
	try {
		await apiFetch(`/api/services/${teamId}/${service.id}/volumes`, {
			method: 'POST',
			body: JSON.stringify({
				name: DEV_ENV_VOLUME.name,
				mountPath: DEV_ENV_VOLUME.mountPath,
				sizeGb,
			}),
		});
		volSpinner.stop(`${green('+')} Workspace volume attached`);
	} catch (err) {
		volSpinner.stop(red('Failed to attach workspace volume'));
		return handleError(err);
	}

	if (noDeploy) {
		console.log();
		console.log(dim('Skipped first deploy (--no-deploy). Deploy when ready:'));
		console.log(`  ${cyan(`hoststack deploy trigger ${service.publicId}`)}`);
		return;
	}

	const deploySpinner = spinner('Starting first deploy...');
	try {
		await apiFetch(`/api/services/${teamId}/${service.id}/deploys`, {
			method: 'POST',
			body: JSON.stringify({}),
		});
		deploySpinner.stop(`${green('+')} Deploy started`);
	} catch (err) {
		deploySpinner.stop(red('Failed to start deploy'));
		return handleError(err);
	}

	console.log();
	console.log(`${bold('Your AI dev environment is provisioning.')}`);
	console.log(dim('Once it is running, open a terminal into it:'));
	console.log(`  ${cyan(`hoststack logs ${service.publicId}`)}      ${dim('# watch boot')}`);
	console.log(
		`  ${dim('Dashboard → Services →')} ${service.publicId} ${dim('→ Terminal (also works from your phone)')}`,
	);
	if (!hoststackKey) {
		console.log();
		console.log(
			dim('Tip: set HOSTSTACK_API_KEY to enable the hoststack MCP inside the container:'),
		);
		console.log(
			`  ${cyan(`hoststack env set ${service.publicId} HOSTSTACK_API_KEY=hs_live_… --secret`)}`,
		);
	}
}

/**
 * `hoststack dev create --service <id>` — spin up a dev box that runs a clone
 * of an existing service's app: the repo is auto-cloned into /workspace,
 * env-vars are copied, and the linked database is cloned (unless --no-db) so it
 * never touches prod. Returns an unguessable public dev URL with seamless push.
 *
 * `--machine` places the box on one of the team's own machines, as it does on
 * `dev new` and `dev create`. Omitted, the box follows the source service —
 * which is what a user debugging their own hardware wants and is why the flag
 * was not needed at first, but it is the only way to ask for anything else.
 */
async function spinUpFromService(
	teamId: number,
	serviceRaw: string,
	args: string[],
): Promise<void> {
	const includeDatabaseClone = !args.includes('--no-db');
	const name = flagValue(args, '--name');
	const serviceId = await resolveServiceId(teamId, serviceRaw);
	// Resolved before the box is asked for, same as the sibling commands: an
	// unknown machine name costs one error message, not an abandoned box.
	const machineId = await machineIdFromFlag(args, teamId);

	const sp = spinner('Spinning up dev environment from service...');
	try {
		const result = await apiFetch<{
			service: Service;
			devUrl: string;
			deployId: number | null;
		}>(`/api/services/${teamId}/${serviceId}/dev-environment`, {
			method: 'POST',
			body: JSON.stringify({
				includeDatabaseClone,
				...(name ? { name } : {}),
				...(machineId !== undefined ? { machineId } : {}),
			}),
		});
		sp.stop(`Created ${bold(result.service.name)} ${dim(`(${result.service.publicId})`)}`);
		console.log();
		console.log(`${bold('Dev environment provisioning.')} View the running app at:`);
		// Not a bare 502: nginx owns the *.hoststack.dev dev block and intercepts
		// the upstream-down statuses — `proxy_intercept_errors on;` +
		// `error_page 502 503 504 =503 @dev_offline;`
		// (nginx/nginx.conf.template:360-361) serving nginx/dev-placeholder.html
		// ("No app listening yet", :15) as a 503 (:364-368, bind-mounted at
		// docker-compose.prod.yml:43).
		console.log(
			`  ${cyan(`https://${result.devUrl}`)}   ${dim('("No app listening yet" until your dev server starts)')}`,
		);
		console.log();
		console.log(dim('Open a terminal (also from your phone):'));
		console.log(`  ${dim('Dashboard → Development →')} ${result.service.publicId}`);
		console.log(dim('Tear it all down when done:'));
		console.log(`  ${cyan(`hoststack dev delete ${result.service.publicId}`)}`);
	} catch (err) {
		sp.stop(red('Failed'));
		return handleError(err);
	}
}

/**
 * `hoststack dev delete <id>` — tear a dev environment down: removes the dev
 * box, its cloned database, the /workspace volume, and the empty development
 * environment. Takes the dev box's id or `svc_…` publicId.
 */
async function deleteDevEnv(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const target = args.find((a) => !a.startsWith('--'));
	if (!target) {
		console.error(red('Usage: hoststack dev delete <id|svc_…>'));
		process.exit(1);
	}
	const serviceId = await resolveServiceId(teamId, target);

	const sp = spinner('Deleting dev environment...');
	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/dev-environment`, {
			method: 'DELETE',
		});
		sp.stop(`${green('+')} Dev environment deleted`);
	} catch (err) {
		sp.stop(red('Failed'));
		return handleError(err);
	}
}

type DevEnvSourceBody =
	| { kind: 'github_repo'; githubRepoId: number; branch?: string }
	| { kind: 'url'; cloneUrl: string; branch?: string }
	| { kind: 'blank' };

/**
 * `hoststack dev new` — create a STANDALONE dev environment (no source service):
 * a cloud box from a connected GitHub repo (--github-id), an arbitrary clone URL
 * (--repo), or blank, with optional companion Postgres/Redis/Meilisearch (--db).
 * Lives in the team's hidden Development home.
 */
async function newDevEnv(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	// Optional on purpose, matching the server (createDevEnvironmentSchema): being
	// made to invent a name is the one thing standing between "I want a box" and
	// having one. Omitted, the server derives it from the source — the repo's
	// name, the last segment of a clone URL, or `dev-box`. The MCP surface has
	// always advertised that, so `hoststack dev new` was the only door that still
	// demanded a name for a box the platform was happy to name itself.
	const name = flagValue(args, '--name');
	const branch = flagValue(args, '--branch');
	const repoUrl = flagValue(args, '--repo');
	const githubId = flagValue(args, '--github-id');
	const plan = flagValue(args, '--plan') ?? flagValue(args, '--size');
	const dbCsv = flagValue(args, '--db');
	const databases = dbCsv
		? dbCsv
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

	let source: DevEnvSourceBody;
	if (githubId) {
		source = {
			kind: 'github_repo',
			githubRepoId: Number(githubId),
			...(branch ? { branch } : {}),
		};
	} else if (repoUrl) {
		source = { kind: 'url', cloneUrl: repoUrl, ...(branch ? { branch } : {}) };
	} else {
		source = { kind: 'blank' };
	}

	const machineId = await machineIdFromFlag(args, teamId);

	const sp = spinner('Creating dev environment...');
	try {
		const result = await apiFetch<{
			service: Service;
			devUrl: string;
			deployId: number | null;
		}>(`/api/dev-environments/${teamId}`, {
			method: 'POST',
			body: JSON.stringify({
				...(name ? { name } : {}),
				source,
				databases,
				...(plan ? { plan } : {}),
				...(machineId !== undefined ? { machineId } : {}),
			}),
		});
		sp.stop(`Created ${bold(result.service.name)} ${dim(`(${result.service.publicId})`)}`);
		console.log();
		if (databases.length > 0) {
			console.log(`${dim('Companion services:')} ${databases.join(', ')}`);
		}
		console.log(`${bold('Dev environment provisioning.')} View the running app at:`);
		// Same branded-503 placeholder as spinUpFromService — see the citation
		// there (nginx/nginx.conf.template:360-368, nginx/dev-placeholder.html:15).
		console.log(
			`  ${cyan(`https://${result.devUrl}`)}   ${dim('("No app listening yet" until your dev server starts)')}`,
		);
		console.log();
		console.log(dim('Open a terminal (also from your phone):'));
		console.log(`  ${dim('Dashboard → Development →')} ${result.service.publicId}`);
		console.log(dim('Tear it all down when done:'));
		console.log(`  ${cyan(`hoststack dev delete ${result.service.publicId}`)}`);
	} catch (err) {
		sp.stop(red('Failed'));
		return handleError(err);
	}
}

/** `hoststack dev list` — list the team's dev environments + their companions. */
async function listDevEnvs(): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	try {
		const { environments } = await apiFetch<{
			environments: (Service & { devUrl?: string | null; databases?: string[] })[];
		}>(`/api/dev-environments/${teamId}`, { method: 'GET' });
		if (environments.length === 0) {
			console.log(dim('No dev environments. Create one: hoststack dev new --name <name>'));
			return;
		}
		for (const env of environments) {
			const dbs =
				env.databases && env.databases.length > 0
					? `  ${dim(env.databases.join(', '))}`
					: '';
			console.log(`${bold(env.name)} ${dim(`(${env.publicId})`)}  ${cyan(env.status)}${dbs}`);
		}
	} catch (err) {
		return handleError(err);
	}
}
