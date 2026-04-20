import { spawn } from 'node:child_process';

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

interface Database {
	id: number;
	publicId: string;
	name: string;
	type: string;
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
	database: string;
	connectionUrl: string;
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
		case 'delete':
		case 'rm':
			return deleteDatabase(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack db <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list --project <id>       List databases in a project');
			console.log('  get <id>                  Get database details');
			console.log('  create --project <id>     Create a new database');
			console.log('  credentials <id>          Show connection credentials');
			console.log('  connect <id>              Connect via psql/redis-cli');
			console.log('  delete <id>               Delete a database');
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
				['ID', 'Name', 'Type', 'Status', 'Created'],
				databases.map((d) => [
					d.publicId,
					d.name,
					d.type,
					statusBadge(d.status),
					new Date(d.createdAt).toLocaleDateString(),
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
		console.log(`${bold('Type:')}    ${d.type}`);
		console.log(`${bold('Status:')}  ${statusBadge(d.status)}`);
		if (d.version) console.log(`${bold('Version:')} ${d.version}`);
		console.log(`${bold('Created:')} ${new Date(d.createdAt).toLocaleString()}`);
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
	const projectId = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
	const nameIdx = args.indexOf('--name');
	const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
	const typeIdx = args.indexOf('--type');
	const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;

	if (!projectId || !name || !type) {
		console.log(
			`${bold('Usage:')} hoststack db create --project <project-id> --name <name> --type <postgres|redis> [--version <version>]`,
		);
		process.exit(1);
	}

	const versionIdx = args.indexOf('--version');
	const version = versionIdx !== -1 ? args[versionIdx + 1] : undefined;

	const s = spinner('Creating database...');

	try {
		const body: Record<string, unknown> = { name, type, projectId: Number(projectId) };
		if (version) body.version = version;

		const result = await apiFetch<{ database: Database }>(`/api/databases/${teamId}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		s.stop('Database created');
		console.log(
			`${green('+')} ${bold(result.database.name)} ${dim(`(${result.database.publicId})`)}`,
		);
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
		console.log(`${bold('Database:')} ${c.database}`);
		console.log();
		console.log(`${bold('Connection URL:')}`);
		console.log(cyan(c.connectionUrl));
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

		let cmd: string[];
		if (db.type === 'redis') {
			cmd = ['redis-cli', '-h', c.host, '-p', String(c.port), '-a', c.password];
			console.log(`Connecting to Redis ${bold(db.name)}...`);
		} else {
			cmd = ['psql', c.connectionUrl];
			console.log(`Connecting to PostgreSQL ${bold(db.name)}...`);
		}

		console.log(dim(`$ ${cmd.join(' ')}`));
		console.log();

		const [bin, ...rest] = cmd;
		if (!bin) {
			console.error(red('Invalid connect command.'));
			process.exit(1);
		}
		const proc = spawn(bin, rest, { stdio: 'inherit' });
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
