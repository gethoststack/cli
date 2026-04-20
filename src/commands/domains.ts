import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, statusBadge, table } from '../lib/output.ts';

interface Domain {
	id: number;
	publicId?: string;
	domain: string;
	status: string;
	serviceId?: number;
	verified: boolean;
	createdAt: string;
}

export async function domainsCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listDomains(args.slice(1));
		case 'add':
		case 'create':
			return addDomain(args.slice(1));
		case 'verify':
			return verifyDomain(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteDomain(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack domains <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list              List all domains');
			console.log('  add               Add a custom domain');
			console.log('  verify <id>       Verify domain DNS');
			console.log('  delete <id>       Remove a domain');
			process.exit(1);
	}
}

async function listDomains(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ domains: Domain[] }>(`/api/domains/${teamId}`);
		const domains = data.domains;

		if (jsonFlag) {
			console.log(JSON.stringify(domains, null, 2));
			return;
		}

		if (domains.length === 0) {
			console.log(dim('No domains found. Add one with: hoststack domains add'));
			return;
		}

		console.log(
			table(
				['Domain', 'Status', 'Verified', 'Created'],
				domains.map((d) => [
					d.domain,
					statusBadge(d.status),
					d.verified ? green('yes') : red('no'),
					new Date(d.createdAt).toLocaleDateString(),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function addDomain(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const domainIdx = args.indexOf('--domain');
	const domain = domainIdx !== -1 ? args[domainIdx + 1] : args[0];
	const serviceIdx = args.indexOf('--service');
	const serviceId = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

	if (!domain) {
		console.log(`${bold('Usage:')} hoststack domains add <domain> [--service <service-id>]`);
		process.exit(1);
	}

	const s = spinner('Adding domain...');

	try {
		const body: Record<string, unknown> = { domain };
		if (serviceId) body.serviceId = serviceId;

		const result = await apiFetch<{ domain: Domain }>(`/api/domains/${teamId}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		s.stop('Domain added');
		console.log(`${green('+')} ${bold(result.domain.domain)}`);
		console.log();
		console.log(`Next: Verify DNS with ${dim('hoststack domains verify <domain-id>')}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function verifyDomain(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const domainId = args[0];
	if (!domainId) {
		console.log(`${bold('Usage:')} hoststack domains verify <domain-id>`);
		process.exit(1);
	}

	const s = spinner('Verifying DNS...');

	try {
		await apiFetch(`/api/domains/${teamId}/${domainId}/verify`, { method: 'POST' });
		s.stop(green('Domain verified'));
	} catch (err) {
		s.stop(red('Verification failed'));
		handleError(err);
	}
}

async function deleteDomain(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const domainId = args[0];
	if (!domainId) {
		console.log(`${bold('Usage:')} hoststack domains delete <domain-id>`);
		process.exit(1);
	}

	const s = spinner('Removing domain...');

	try {
		await apiFetch(`/api/domains/${teamId}/${domainId}`, { method: 'DELETE' });
		s.stop('Domain removed');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
