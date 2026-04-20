import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, statusBadge, table } from '../lib/output.ts';

interface Service {
	id: number;
	publicId: string;
	name: string;
	type: string;
	status: string;
	internalUrl?: string | null;
	projectId: number;
	createdAt: string;
}

export async function servicesCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listServices(args.slice(1));
		case 'get':
		case 'info':
			return getService(args.slice(1));
		case 'create':
			return createService(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteService(args.slice(1));
		case 'suspend':
			return suspendService(args.slice(1));
		case 'resume':
			return resumeService(args.slice(1));
		case 'scale':
			return scaleService(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack services <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list              List all services');
			console.log('  get <id>          Get service details');
			console.log('  create            Create a new service');
			console.log('  delete <id>       Delete a service');
			console.log('  suspend <id>      Suspend a service');
			console.log('  resume <id>       Resume a suspended service');
			console.log('  scale <id> <n>    Scale service to n instances');
			process.exit(1);
	}
}

async function listServices(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ services: Service[] }>(`/api/services/${teamId}`);
		const services = data.services;

		if (jsonFlag) {
			console.log(JSON.stringify(services, null, 2));
			return;
		}

		if (services.length === 0) {
			console.log(dim('No services found. Create one with: hoststack services create'));
			return;
		}

		console.log(
			table(
				['ID', 'Name', 'Type', 'Status', 'Created'],
				services.map((s) => [
					s.publicId,
					s.name,
					s.type,
					statusBadge(s.status),
					new Date(s.createdAt).toLocaleDateString(),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function getService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack services get <service-id>`);
		process.exit(1);
	}

	try {
		const data = await apiFetch<{ service: Service }>(`/api/services/${teamId}/${serviceId}`);
		const s = data.service;

		console.log(`${bold('Name:')}       ${s.name}`);
		console.log(`${bold('ID:')}         ${s.publicId}`);
		console.log(`${bold('Type:')}       ${s.type}`);
		console.log(`${bold('Status:')}     ${statusBadge(s.status)}`);
		if (s.internalUrl) {
			console.log(`${bold('Internal:')}   ${s.internalUrl}`);
		}
		console.log(`${bold('Created:')}    ${new Date(s.createdAt).toLocaleString()}`);
	} catch (err) {
		handleError(err);
	}
}

async function createService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const nameIdx = args.indexOf('--name');
	const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
	const typeIdx = args.indexOf('--type');
	const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
	const projectIdx = args.indexOf('--project');
	const projectId = projectIdx !== -1 ? args[projectIdx + 1] : undefined;

	if (!name || !type) {
		console.log(
			`${bold('Usage:')} hoststack services create --name <name> --type <web|worker|cron> [--project <project-id>]`,
		);
		process.exit(1);
	}

	const s = spinner('Creating service...');

	try {
		const body: Record<string, unknown> = { name, type };
		if (projectId) body.projectId = projectId;

		const result = await apiFetch<{ service: Service }>(`/api/services/${teamId}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		s.stop('Service created');
		console.log(
			`${green('+')} ${bold(result.service.name)} ${dim(`(${result.service.publicId})`)}`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack services delete <service-id>`);
		process.exit(1);
	}

	const s = spinner('Deleting service...');

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}`, { method: 'DELETE' });
		s.stop('Service deleted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function suspendService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack services suspend <service-id>`);
		process.exit(1);
	}

	const s = spinner('Suspending service...');

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/suspend`, { method: 'POST' });
		s.stop('Service suspended');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function scaleService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	const countStr = args[1];
	if (!serviceId || !countStr) {
		console.log(`${bold('Usage:')} hoststack services scale <service-id> <instance-count>`);
		process.exit(1);
	}

	const instanceCount = parseInt(countStr, 10);
	if (isNaN(instanceCount) || instanceCount < 0) {
		console.error(red('Instance count must be a non-negative integer.'));
		process.exit(1);
	}

	const s = spinner(`Scaling to ${instanceCount} instance(s)...`);

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/config`, {
			method: 'PATCH',
			body: JSON.stringify({ instanceCount }),
		});
		s.stop(`Scaled to ${bold(String(instanceCount))} instance(s)`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function resumeService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack services resume <service-id>`);
		process.exit(1);
	}

	const s = spinner('Resuming service...');

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/resume`, { method: 'POST' });
		s.stop('Service resumed');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
