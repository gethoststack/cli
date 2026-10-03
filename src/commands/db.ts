import { spawn } from 'node:child_process';
import { text as readStream } from 'node:stream/consumers';

import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDate, formatDateTime } from '../lib/format.ts';
import { resolveProjectId } from '../lib/resolve.ts';
import { machineIdFromFlag } from './machines.ts';
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
	yellow,
} from '../lib/output.ts';

interface Database {
	id: number;
	publicId: string;
	name: string;
	/** Canonical field on the API response. */
	engine: string;
	/** Deprecated alias — older API revisions returned `type` instead of `engine`. */
	type?: string;
	status: string;
	version?: string;
	projectId: number;
	createdAt: string;
}

interface DatabaseCredentials {
	host: string;
	port: number;
	username: string;
	password: string;
	// `databaseName`, as the API and the SDK both spell it. This was `database`,
	// which no response has ever carried, so `hoststack db credentials` printed
	// "Database: undefined" beside a connection URL holding the right name —
	// and the parts are exactly what you reach for when a client wants them
	// rather than the URL (task 442). The cosmetic half is what was reported;
	// the same field also builds `db connect`'s argv, so `psql -d undefined`,
	// `mysql undefined` and `mongodb://host:port/undefined` were what that
	// command has been running for postgres, mysql/mariadb and mongodb.
	databaseName: string;
	connectionUrl: string;
	// Render-style external connectivity — present when external access is
	// enabled. The internal fields above stay the in-cluster endpoint; these
	// are the public host:port reachable from a laptop (TLS required).
	externalAccessEnabled?: boolean;
	externalHost?: string | null;
	externalPort?: number | null;
	externalConnectionUrl?: string | null;
	externalAllowedIps?: string[];
}

interface ExternalAccessResult {
	externalAccessEnabled: boolean;
	externalHost: string | null;
	externalPort: number | null;
	externalConnectionUrl: string | null;
	externalAllowedIps: string[];
}

export async function dbCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listDatabases(args.slice(1));
		case 'get':
		case 'info':
			return getDatabase(args.slice(1));
		case 'create':
			return createDatabase(args.slice(1));
		case 'credentials':
		case 'creds':
			return getCredentials(args.slice(1));
		case 'connect':
			return connectDatabase(args.slice(1));
		case 'external':
			return externalAccess(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteDatabase(args.slice(1));
		case 'link':
			return linkDatabase(args.slice(1));
		case 'unlink':
			return unlinkDatabase(args.slice(1));
		case 'links':
			return listLinks(args.slice(1));
		case 'suspend':
			return suspendDatabase(args.slice(1));
		case 'resume':
			return resumeDatabase(args.slice(1));
		case 'restart':
			return restartDatabase(args.slice(1));
		case 'update':
		case 'edit':
			return updateDatabase(args.slice(1));
		case 'query':
		case 'sql':
			return queryDatabase(args.slice(1));
		case 'upgrade-version':
			return upgradeVersion(args.slice(1));
		case 'upgrade-to-ha':
			return upgradeToHa(args.slice(1));
		case 'cluster':
			return clusterInfo(args.slice(1));
		case 'backups':
			return listRestorePoints(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack db <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list --project <id>       List databases in a project');
			console.log('  get <id>                  Get database details');
			console.log('  create --project <id>     Create a new database');
			console.log('  credentials <id>          Show connection credentials');
			console.log('  connect <id>              Connect via psql/redis-cli');
			console.log(
				'  external <id> --enable|--disable [--allow <cidr> ...]  Toggle external (public) access',
			);
			console.log('  update <id> [--name <n>] [--plan <p>] [--disk <gb>]   Rename / resize');
			console.log('  query <id> "<sql>"        One READ-ONLY statement (Postgres)');
			console.log('  delete <id>               Delete a database');
			console.log('  suspend <id>              Stop the container, keep the data');
			console.log('  resume <id>               Restart a suspended database');
			console.log('  restart <id>              Bounce the container in place');
			console.log();
			console.log('Connecting a database to an app:');
			console.log(
				'  link <db-id> --service <svc-id> [--alias <PREFIX>]   Inject its URL into a service',
			);
			console.log('  links --service <svc-id>   List resources linked to a service');
			console.log('  unlink --service <svc-id> --link <link-id>   Remove a link');
			console.log(
				dim('  A link takes effect on the NEXT deploy: hoststack deploy trigger <svc-id>'),
			);
			console.log();
			console.log('  upgrade-version <id> --to <v>   In-place engine major upgrade');
			console.log('  upgrade-to-ha <id>        Migrate a standalone Postgres to HA');
			console.log('  cluster <id>              Show HA cluster topology + failovers');
			console.log();
			console.log('  backups <id>              Off-site archives you could restore from');
			console.log(
				dim('  A nightly schedule is a promise; this is the evidence. Check it for'),
			);
			console.log(dim('  anything whose loss is not survivable.'));
			process.exit(1);
	}
}

async function listDatabases(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const projectIdx = args.indexOf('--project');
	const projectId = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
	if (!projectId) {
		console.log(`${bold('Usage:')} hoststack db list --project <project-id> [--json]`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ databases: Database[] }>(
			`/api/databases/${teamId}?projectId=${projectId}`,
		);
		const databases = data.databases;

		if (jsonFlag) {
			console.log(JSON.stringify(databases, null, 2));
			return;
		}

		if (databases.length === 0) {
			console.log(dim('No databases found. Create one with: hoststack db create'));
			return;
		}

		console.log(
			table(
				['ID', 'Name', 'Engine', 'Status', 'Created'],
				databases.map((d) => [
					d.publicId,
					d.name,
					d.engine ?? d.type ?? '',
					statusBadge(d.status),
					formatDate(d.createdAt),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function getDatabase(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db get <database-id>`);
		process.exit(1);
	}

	try {
		const data = await apiFetch<{ database: Database }>(`/api/databases/${teamId}/${dbId}`);
		const d = data.database;

		console.log(`${bold('Name:')}    ${d.name}`);
		console.log(`${bold('ID:')}      ${d.publicId}`);
		console.log(`${bold('Engine:')}  ${d.engine ?? d.type ?? ''}`);
		console.log(`${bold('Status:')}  ${statusBadge(d.status)}`);
		if (d.version) console.log(`${bold('Version:')} ${d.version}`);
		console.log(`${bold('Created:')} ${formatDateTime(d.createdAt)}`);
	} catch (err) {
		handleError(err);
	}
}

async function createDatabase(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const projectIdx = args.indexOf('--project');
	const projectRaw = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
	const nameIdx = args.indexOf('--name');
	const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
	// Engine is the canonical field name on the API (it backs the
	// `database_engine` Postgres enum). `--type` is accepted for
	// backwards-compat with the v0.1 CLI but routed to the same field.
	const engineIdx = args.indexOf('--engine');
	const typeIdx = args.indexOf('--type');
	const engine =
		engineIdx !== -1 ? args[engineIdx + 1] : typeIdx !== -1 ? args[typeIdx + 1] : undefined;

	if (!projectRaw || !name || !engine) {
		console.log(
			`${bold('Usage:')} hoststack db create --project <project-id|prj_…> --name <name> --engine <postgres|redis|mysql|mariadb|mongodb> [--version <version>] [--plan <micro|starter|standard|pro>] [--machine <name|id>]`,
		);
		process.exit(1);
	}

	const projectId = await resolveProjectId(teamId, projectRaw);

	const versionIdx = args.indexOf('--version');
	const version = versionIdx !== -1 ? args[versionIdx + 1] : undefined;
	const planIdx = args.indexOf('--plan');
	const plan = planIdx !== -1 ? args[planIdx + 1] : undefined;
	// Resolved before the spinner starts: an unknown machine name should end in
	// an error and a list of real ones, not a half-drawn "Creating database...".
	const machineId = await machineIdFromFlag(args, teamId);

	const s = spinner('Creating database...');

	try {
		const body: Record<string, unknown> = { name, engine, projectId };
		if (version) body.version = version;
		if (plan) body.plan = plan;
		if (machineId !== undefined) body.machineId = machineId;

		const result = await apiFetch<{ database: Database }>(`/api/databases/${teamId}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		s.stop('Database created');
		console.log(
			`${green('+')} ${bold(result.database.name)} ${dim(`(${result.database.publicId})`)}`,
		);
		if (machineId !== undefined) {
			// The constraint that bites later if it is not said now: project
			// networks are host-local, so a service anywhere else cannot reach
			// this database and the API refuses to link them.
			console.log(
				dim(
					'On your own machine — reachable only from that machine, so run the app that uses it there too.',
				),
			);
		}
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function getCredentials(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db credentials <database-id>`);
		process.exit(1);
	}

	try {
		const data = await apiFetch<{ credentials: DatabaseCredentials }>(
			`/api/databases/${teamId}/${dbId}/credentials`,
		);
		const c = data.credentials;

		console.log(`${bold('Host:')}     ${c.host}`);
		console.log(`${bold('Port:')}     ${c.port}`);
		console.log(`${bold('User:')}     ${c.username}`);
		console.log(`${bold('Password:')} ${c.password}`);
		console.log(`${bold('Database:')} ${c.databaseName}`);
		console.log();
		console.log(`${bold('Connection URL (internal):')}`);
		console.log(cyan(c.connectionUrl));

		if (c.externalAccessEnabled && c.externalConnectionUrl) {
			console.log();
			console.log(`${bold('External (from your machine):')}`);
			console.log(cyan(c.externalConnectionUrl));
			if (c.externalHost) console.log(`${dim('Host:')} ${c.externalHost}`);
			if (c.externalPort) console.log(`${dim('Port:')} ${c.externalPort}`);
			const ips = c.externalAllowedIps ?? [];
			console.log(
				`${dim('Allowlist:')} ${ips.length > 0 ? ips.join(', ') : dim('any IP (TLS only)')}`,
			);
		}
	} catch (err) {
		handleError(err);
	}
}

async function connectDatabase(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db connect <database-id>`);
		process.exit(1);
	}

	try {
		// First get the database info to determine type
		const dbData = await apiFetch<{ database: Database }>(`/api/databases/${teamId}/${dbId}`);
		const db = dbData.database;

		// Then get credentials
		const credData = await apiFetch<{ credentials: DatabaseCredentials }>(
			`/api/databases/${teamId}/${dbId}/credentials`,
		);
		const c = credData.credentials;

		// When external access is on, the in-cluster host:port isn't reachable
		// from a laptop — prefer the public endpoint so `db connect` actually
		// connects. Falls back to the internal endpoint when external is off.
		const useExternal = !!(c.externalAccessEnabled && c.externalHost && c.externalPort);
		const host = useExternal ? c.externalHost! : c.host;
		const port = useExternal ? c.externalPort! : c.port;
		if (useExternal) {
			console.log(dim('Using external (public) endpoint — external access is enabled.'));
		}

		const engine = db.engine ?? db.type;
		let cmd: string[];
		// Pass passwords through environment variables, never via -p / -a CLI
		// flags or via the connection URL. CLI args appear in `ps` and shell
		// history; env vars are scoped to the child process only.
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (engine === 'redis') {
			cmd = ['redis-cli', '-h', host, '-p', String(port)];
			env.REDISCLI_AUTH = c.password;
			console.log(`Connecting to Redis ${bold(db.name)}...`);
		} else if (engine === 'mongodb') {
			// mongosh doesn't read passwords from env vars. Build a URI
			// without the password and pass --password via stdin: when
			// `--password` is supplied with no value alongside `--username`,
			// mongosh prompts on stderr; piping the password + newline to
			// stdin satisfies the prompt without it ever entering argv.
			cmd = [
				'mongosh',
				`mongodb://${host}:${port}/${c.databaseName}`,
				'--username',
				c.username,
				'--password',
			];
			console.log(`Connecting to MongoDB ${bold(db.name)}...`);
		} else if (engine === 'mysql' || engine === 'mariadb') {
			cmd = ['mysql', '-h', host, '-P', String(port), '-u', c.username, c.databaseName];
			env.MYSQL_PWD = c.password;
			console.log(`Connecting to ${engine} ${bold(db.name)}...`);
		} else {
			// Postgres: build per-flag args + PGPASSWORD so the password
			// never lands in argv (was being passed via connectionUrl).
			cmd = ['psql', '-h', host, '-p', String(port), '-U', c.username, '-d', c.databaseName];
			env.PGPASSWORD = c.password;
			console.log(`Connecting to PostgreSQL ${bold(db.name)}...`);
		}

		console.log(dim(`$ ${cmd.join(' ')}`));
		console.log();

		const [bin, ...rest] = cmd;
		if (!bin) {
			console.error(red('Invalid connect command.'));
			process.exit(1);
		}

		// Mongo needs stdin piping for the password prompt; everything
		// else can inherit stdin directly.
		const needsStdinPipe = engine === 'mongodb';
		const proc = spawn(bin, rest, {
			stdio: needsStdinPipe ? ['pipe', 'inherit', 'inherit'] : 'inherit',
			env,
		});

		if (needsStdinPipe && proc.stdin) {
			// Write password + newline to satisfy the prompt, then proxy
			// the parent's stdin so the user can interact normally.
			proc.stdin.write(`${c.password}\n`);
			process.stdin.pipe(proc.stdin);
			if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
				process.stdin.setRawMode(true);
			}
		}

		const exitCode: number = await new Promise((resolve) => {
			proc.on('exit', (code) => resolve(code ?? 1));
			proc.on('error', (err) => {
				console.error(red(`Failed to launch ${bin}: ${err.message}`));
				resolve(1);
			});
		});
		process.exit(exitCode);
	} catch (err) {
		handleError(err);
	}
}

async function externalAccess(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	const enable = args.includes('--enable');
	const disable = args.includes('--disable');

	if (!dbId || dbId.startsWith('--') || (!enable && !disable) || (enable && disable)) {
		console.log(
			`${bold('Usage:')} hoststack db external <database-id> --enable [--allow <cidr> ...] | --disable`,
		);
		console.log();
		console.log(dim('Exposes the database on a stable public host:port (TLS required).'));
		console.log(
			dim('Repeat --allow to restrict source IPs; omit it to allow any IP over TLS.'),
		);
		process.exit(1);
	}

	// Collect every `--allow <cidr>` pair into an array.
	const allowedIps: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--allow' && args[i + 1]) {
			allowedIps.push(args[i + 1] as string);
		}
	}

	const s = spinner(enable ? 'Enabling external access...' : 'Disabling external access...');

	try {
		const body: { enabled: boolean; allowedIps?: string[] } = { enabled: enable };
		if (enable && allowedIps.length > 0) body.allowedIps = allowedIps;

		const result = await apiFetch<{ externalAccess: ExternalAccessResult }>(
			`/api/databases/${teamId}/${dbId}/external-access`,
			{ method: 'POST', body: JSON.stringify(body) },
		);
		const ext = result.externalAccess;
		s.stop(ext.externalAccessEnabled ? 'External access enabled' : 'External access disabled');

		if (ext.externalAccessEnabled) {
			console.log();
			if (ext.externalConnectionUrl) {
				console.log(`${bold('External connection URL:')}`);
				console.log(cyan(ext.externalConnectionUrl));
			}
			if (ext.externalHost) console.log(`${bold('Host:')} ${ext.externalHost}`);
			if (ext.externalPort) console.log(`${bold('Port:')} ${ext.externalPort}`);
			console.log(
				`${bold('Allowlist:')} ${
					ext.externalAllowedIps.length > 0
						? ext.externalAllowedIps.join(', ')
						: dim('any IP (TLS only)')
				}`,
			);
		} else {
			console.log(
				dim('The database is now private — reachable only from services in its project.'),
			);
		}
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteDatabase(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db delete <database-id>`);
		process.exit(1);
	}

	const s = spinner('Deleting database...');

	try {
		await apiFetch(`/api/databases/${teamId}/${dbId}`, { method: 'DELETE' });
		s.stop('Database deleted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

interface ResourceLink {
	id: number;
	resourceType: string;
	resourceId: number;
	alias: string;
	createdAt: string;
}

/** Shared arg-parsing + auth preamble for the link subcommands. */
function requireTeam(): number {
	const teamId = getTeamId();
	if (teamId === null) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	return teamId;
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

async function linkDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0]?.startsWith('--') ? undefined : args[0];
	const serviceId = flag(args, '--service');
	if (!dbId || !serviceId) {
		console.log(
			`${bold('Usage:')} hoststack db link <database-id> --service <service-id> [--alias <PREFIX>]`,
		);
		console.log();
		console.log(dim('Binds a managed database to a service. On the next deploy the platform'));
		console.log(dim('injects DATABASE_URL / REDIS_URL / MONGO_URL plus <PREFIX>_* vars into'));
		console.log(dim('the container — you never handle the password yourself.'));
		console.log();
		console.log(dim('Default alias is derived from the database name.'));
		process.exit(1);
	}

	const s = spinner('Linking database...');
	try {
		// The link API keys off the NUMERIC resource id, so resolve the
		// publicId the user typed into a row first.
		const { database } = await apiFetch<{ database: Database }>(
			`/api/databases/${teamId}/${dbId}`,
		);
		// Aliases must match /^[A-Z][A-Z0-9_]*$/, so uppercase the name, replace
		// anything illegal with an underscore, and drop any leading non-letters.
		// A name of only digits/punctuation reduces to empty — fall back to DB.
		const derivedAlias =
			database.name
				.toUpperCase()
				.replace(/[^A-Z0-9_]/g, '_')
				.replace(/^[^A-Z]+/, '') || 'DB';
		const alias = flag(args, '--alias') ?? derivedAlias;

		const { link } = await apiFetch<{ link: ResourceLink }>(
			`/api/services/${teamId}/${serviceId}/resources`,
			{
				method: 'POST',
				body: JSON.stringify({
					resourceType: 'database',
					resourceId: database.id,
					alias,
				}),
			},
		);
		s.stop('Linked');
		console.log(
			`${green('+')} ${bold(database.name)} ${dim(`->`)} ${bold(serviceId)} ${dim(`(alias ${link.alias})`)}`,
		);
		console.log();
		console.log(dim('Takes effect on the next deploy:'));
		console.log(`  ${cyan(`hoststack deploy trigger ${serviceId}`)}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function listLinks(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const serviceId = flag(args, '--service') ?? (args[0]?.startsWith('--') ? undefined : args[0]);
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack db links --service <service-id>`);
		process.exit(1);
	}

	const s = spinner('Loading links...');
	try {
		const { links } = await apiFetch<{ links: ResourceLink[] }>(
			`/api/services/${teamId}/${serviceId}/resources`,
		);
		s.stop();
		if (links.length === 0) {
			console.log(dim('No resources linked to this service.'));
			console.log(
				dim(
					'Nothing is being injected. Link one with: hoststack db link <db-id> --service <svc-id>',
				),
			);
			return;
		}
		console.log(
			table(
				['LINK ID', 'TYPE', 'RESOURCE', 'ALIAS'],
				links.map((l) => [String(l.id), l.resourceType, String(l.resourceId), l.alias]),
			),
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function unlinkDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const serviceId = flag(args, '--service');
	const linkId = flag(args, '--link');
	if (!serviceId || !linkId) {
		console.log(
			`${bold('Usage:')} hoststack db unlink --service <service-id> --link <link-id>`,
		);
		console.log();
		console.log(dim('Find the link id with: hoststack db links --service <service-id>'));
		console.log(dim('Removes the binding only — the database and its data are untouched.'));
		process.exit(1);
	}

	const s = spinner('Unlinking...');
	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/resources/${linkId}`, {
			method: 'DELETE',
		});
		s.stop('Unlinked');
		console.log(dim('The injected env vars disappear on the next deploy.'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function suspendDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db suspend <database-id>`);
		console.log();
		console.log(dim('Stops the container but KEEPS the volume and all data.'));
		console.log(dim('Reverse it with: hoststack db resume <database-id>'));
		process.exit(1);
	}

	const s = spinner('Suspending...');
	try {
		await apiFetch(`/api/databases/${teamId}/${dbId}/suspend`, { method: 'POST' });
		s.stop('Suspended');
		console.log(dim('Data preserved. Resume restores it on the same connection URL.'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function resumeDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db resume <database-id>`);
		process.exit(1);
	}

	const s = spinner('Resuming...');
	try {
		await apiFetch(`/api/databases/${teamId}/${dbId}/resume`, { method: 'POST' });
		s.stop('Resume dispatched');
		console.log(dim('Same connection URL — linked services do not need a redeploy.'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function upgradeToHa(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db upgrade-to-ha <database-id>`);
		console.log();
		console.log(dim('Migrates a standalone Postgres database to a 3-node Patroni HA cluster.'));
		console.log(dim('Requires PATRONI_ENABLED on the deployment + ha_beta=true on your team.'));
		console.log(
			dim('Brief read-only window during cutover; standalone kept for 24h rollback.'),
		);
		process.exit(1);
	}

	const s = spinner('Starting HA migration...');
	try {
		await apiFetch(`/api/databases/${teamId}/${dbId}/upgrade-to-ha`, {
			method: 'POST',
		});
		s.stop('HA migration started');
		console.log(
			dim(
				`Poll with: hoststack db get ${dbId} — wait for pgEngineType=patroni + status=available.`,
			),
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

interface ClusterMember {
	id: number;
	memberRole: 'etcd' | 'primary-candidate' | 'replica' | 'proxy';
	containerId: string;
	workerHostId: number | null;
	joinedAt: string;
	leftAt: string | null;
}

interface ClusterFailover {
	id: number;
	createdAt: string;
	oldLeader: string | null;
	newLeader: string | null;
}

interface RestorePoint {
	id: number;
	archiveName: string;
	sizeBytes: number | null;
	createdAt: string;
	s3Url: string;
}

/** Bytes as a human reads them; `—` when the machine reported no size. */
function formatBytes(bytes: number | null): string {
	if (bytes === null) return dim('—');
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The off-site archives a database could actually be restored from.
 *
 * Separate from what the machine has on its disk, which is what the dashboard's Backups page
 * lists. On a machine of your own with no upload grant the dump lands on the disk holding the
 * database, and a copy that dies with the original is not a copy — so this prints the rows the
 * platform wrote when an archive reached object storage, and nothing else.
 */
async function listRestorePoints(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db backups <database-id> [--json]`);
		process.exit(1);
	}
	const jsonFlag = args.includes('--json');

	try {
		const { restorePoints } = await apiFetch<{ restorePoints: RestorePoint[] }>(
			`/api/databases/${teamId}/${dbId}/restore-points`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(restorePoints, null, 2));
			return;
		}

		if (restorePoints.length === 0) {
			// The distinction that matters: "backups are scheduled" and "a backup exists" are
			// different claims, and only the second one is about recovery.
			console.log(yellow(`No off-site backups recorded for database ${dbId}.`));
			console.log(
				dim('  The nightly schedule says one should exist. Either none has completed'),
			);
			console.log(
				dim("  yet, or every dump is landing on the machine's own disk — which is the"),
			);
			console.log(dim('  same disk as the database, and so is not a copy of anything.'));
			console.log(
				dim(`  Why: hoststack db get ${dbId}  (lastBackupStatus, lastBackupError)`),
			);
			console.log(
				dim('  A lastBackupStatus of offsite_failed means the upload was attempted'),
			);
			console.log(dim('  and failed, and lastBackupError carries the reason.'));
			return;
		}

		console.log(
			table(
				['ID', 'Archive', 'Size', 'Taken'],
				restorePoints.map((p) => [
					String(p.id),
					p.archiveName,
					formatBytes(p.sizeBytes),
					formatDate(p.createdAt),
				]),
			),
		);
		console.log();
		console.log(
			dim('Retention is a few days, so a short list is normal — it is the newest few'),
		);
		console.log(dim('restore points, not every backup ever taken.'));
	} catch (err) {
		handleError(err);
	}
}

async function clusterInfo(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db cluster <database-id> [--json]`);
		process.exit(1);
	}
	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{
			members: ClusterMember[];
			failovers: ClusterFailover[];
		}>(`/api/databases/${teamId}/${dbId}/cluster`);

		if (jsonFlag) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		const live = data.members.filter((m) => m.leftAt === null);
		console.log(bold(`Cluster members (${cyan(String(live.length))} live):`));
		console.log(
			table(
				['Role', 'Container', 'Joined'],
				live.map((m) => [
					m.memberRole,
					m.containerId.slice(0, 12),
					formatDateTime(m.joinedAt),
				]),
			),
		);

		if (data.failovers.length === 0) {
			console.log();
			console.log(green('No failovers recorded.'));
		} else {
			console.log();
			console.log(bold(`Failover history (${data.failovers.length}):`));
			console.log(
				table(
					['When', 'From', 'To'],
					data.failovers.map((f) => [
						formatDateTime(f.createdAt),
						f.oldLeader ?? '—',
						f.newLeader ?? '—',
					]),
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

/**
 * Restart the container in place. Same volume, same connection URL, a few
 * seconds of downtime.
 *
 * Not `suspend` + `resume`: those are a deliberate stop with data preserved,
 * and a suspended database is a billing and availability state somebody may be
 * relying on. This is the "it is wedged, bounce it" verb, and the API refuses
 * it on anything that is not `available` for exactly that reason.
 */
async function restartDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0];
	if (!dbId) {
		console.log(`${bold('Usage:')} hoststack db restart <database-id>`);
		console.log();
		console.log(dim('Bounces the container: same volume, same connection URL, seconds of'));
		console.log(dim('downtime. Every open connection is dropped — clients must reconnect.'));
		console.log(dim('The database must be available; resume a suspended one first.'));
		process.exit(1);
	}

	const s = spinner('Restarting...');
	try {
		await apiFetch(`/api/databases/${teamId}/${dbId}/restart`, { method: 'POST' });
		s.stop('Restarted');
		console.log(dim('Connections were dropped. Apps with a pool reconnect on their own.'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/** Rename, change plan tier, or grow the disk. Disk cannot shrink. */
async function updateDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0]?.startsWith('--') ? undefined : args[0];
	const name = flag(args, '--name');
	const plan = flag(args, '--plan');
	const disk = flag(args, '--disk');

	if (!dbId || (name === undefined && plan === undefined && disk === undefined)) {
		console.log(
			`${bold('Usage:')} hoststack db update <database-id> [--name <name>] [--plan <${DB_PLANS.join('|')}>] [--disk <gb>]`,
		);
		console.log();
		console.log(dim('  --plan changes the memory/CPU tier.'));
		console.log(dim('  --disk GROWS the disk. Shrinking is refused: the filesystem under it'));
		console.log(dim('  would orphan data, so there is no undo for a size you overshot.'));
		process.exit(1);
	}

	const body: Record<string, unknown> = {};
	if (name !== undefined) body.name = name;
	if (plan !== undefined) {
		if (!DB_PLANS.includes(plan)) {
			console.error(red(`Unknown plan "${plan}". One of: ${DB_PLANS.join(', ')}.`));
			process.exit(1);
		}
		body.plan = plan;
	}
	if (disk !== undefined) {
		const parsed = Number.parseInt(disk, 10);
		if (!Number.isInteger(parsed) || parsed < 1) {
			console.error(red(`--disk must be a size in whole GB, got "${disk}".`));
			process.exit(1);
		}
		body.diskSizeGb = parsed;
	}

	const s = spinner('Updating...');
	try {
		const { database } = await apiFetch<{ database: Database }>(
			`/api/databases/${teamId}/${dbId}`,
			{ method: 'PATCH', body: JSON.stringify(body) },
		);
		s.stop('Updated');
		console.log(`${bold(database.name)} ${dim(`(${Object.keys(body).join(', ')})`)}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/** Plan tiers a managed database can sit on. Database sizes, not service sizes. */
const DB_PLANS = ['free', 'micro', 'starter', 'standard', 'pro'];

interface QueryResult {
	columns: string[];
	rows: string[][];
	rowCount: number;
	truncated: boolean;
	durationMs: number;
}

/**
 * One read-only statement against a managed Postgres.
 *
 * The read-only part is not this command's promise to keep — it is enforced
 * server-side inside `BEGIN TRANSACTION READ ONLY`, with a 30s statement
 * timeout and a 1000-row cap, and every call is audit-logged as
 * `database.query` whether it succeeded or not. So this is for looking: a
 * count, a sample, a constraint you are arguing with. Schema changes and seed
 * data ship as migrations.
 */
async function queryDatabase(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0]?.startsWith('--') ? undefined : args[0];
	const rawSql =
		flag(args, '--sql') ?? (args[1] && !args[1].startsWith('--') ? args[1] : undefined);
	const jsonFlag = args.includes('--json');

	if (!dbId || rawSql === undefined) {
		console.log(`${bold('Usage:')} hoststack db query <database-id> "<sql>" [--json]`);
		console.log();
		console.log(dim('  Postgres only. A single SELECT/WITH/SHOW/EXPLAIN, no trailing ";".'));
		console.log(dim('  Enforced server-side: read-only transaction, 30s timeout, 1000 rows.'));
		console.log(dim('  Every call is audit-logged — who queried what, and when.'));
		console.log();
		console.log(dim('  hoststack db query db_abc "SELECT count(*) FROM users"'));
		process.exit(1);
	}

	// `-` reads the statement from stdin. Node APIs, not `Bun.stdin`: this
	// bundle runs under Node once installed from npm.
	let sql = rawSql;
	try {
		if (rawSql === '-') sql = (await readStream(process.stdin)).trim();
	} catch (err) {
		handleError(err);
	}
	if (sql.length === 0) {
		console.error(red('No SQL given.'));
		process.exit(1);
	}

	const s = jsonFlag ? null : spinner('Running...');
	try {
		const result = await apiFetch<QueryResult>(`/api/databases/${teamId}/${dbId}/query`, {
			method: 'POST',
			body: JSON.stringify({ sql }),
		});

		if (jsonFlag) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		s?.stop(
			`${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${result.durationMs}ms`,
		);
		if (result.rowCount === 0) return;
		console.log(table(result.columns, result.rows));

		// The cap is silent in the data — a truncated 1000-row answer looks
		// exactly like a complete one, which is how a count gets quoted wrong.
		if (result.truncated) {
			console.log();
			console.log(yellow('Truncated at the server cap — this is not the whole result set.'));
			console.log(dim('Add a LIMIT and an ORDER BY, or aggregate in SQL instead.'));
		}
	} catch (err) {
		s?.stop(red('Failed'));
		handleError(err);
	}
}

/**
 * In-place engine major-version upgrade. The agent dumps, recreates the
 * container at the new version under the same DNS name, and restores — so
 * connection URLs stay valid and nothing needs a redeploy.
 */
async function upgradeVersion(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const dbId = args[0]?.startsWith('--') ? undefined : args[0];
	const version =
		flag(args, '--to') ?? (args[1] && !args[1].startsWith('--') ? args[1] : undefined);

	if (!dbId || version === undefined) {
		console.log(`${bold('Usage:')} hoststack db upgrade-version <database-id> --to <version>`);
		console.log();
		console.log(dim('  postgres: 18 | 17 | 16 | 15     redis: 8 | 7 | 6'));
		console.log(dim('  Strictly newer only — downgrades are refused, and so are HA clusters'));
		console.log(dim('  and engines where this is not implemented (mysql/mariadb/mongodb).'));
		console.log(dim('  Seconds of downtime; the old container is rolled back on any failure.'));
		console.log();
		console.log(dim(`  Current version: hoststack db get <database-id>`));
		process.exit(1);
	}

	const s = spinner('Starting upgrade...');
	try {
		await apiFetch(`/api/databases/${teamId}/${dbId}/upgrade-version`, {
			method: 'POST',
			body: JSON.stringify({ version }),
		});
		// 202 — accepted, not finished. Saying "upgraded" here would be the
		// same false claim `domains verify` used to make on any 200.
		s.stop('Upgrade started');
		console.log(
			dim(
				`Async. Poll with: hoststack db get ${dbId} — done when version=${version} and status=available.`,
			),
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
