import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDate } from '../lib/format.ts';
import {
	bold,
	dim,
	green,
	handleError,
	red,
	spinner,
	statusBadge,
	table,
	yellow,
} from '../lib/output.ts';
import { resolveServiceId } from '../lib/resolve.ts';

interface Domain {
	id: number;
	publicId?: string;
	domain: string;
	status: string;
	serviceId?: number;
	/**
	 * Not on the list response. The route returns `status` and `verifiedAt`;
	 * there is no `verified` boolean, so reading one printed "no" for every
	 * domain on the team — including ones that had been live for weeks.
	 * `verifiedAt` is what the row actually carries.
	 */
	verifiedAt?: string | null;
	isPrimary?: boolean;
	sslEnabled?: boolean;
	redirectTo?: string | null;
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
		case 'update':
		case 'edit':
			return updateDomain(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteDomain(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack domains <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list              List all domains');
			console.log('  add               Add a custom domain');
			console.log('  verify <domain>   Verify domain DNS');
			console.log('  delete <domain>   Remove a domain');
			console.log();
			console.log();
			console.log(dim('  <domain> is the hostname, its dom_… id, or its numeric id.'));
			console.log(dim('  DNS zones and records live under: hoststack dns'));
			process.exit(1);
	}
}

/**
 * Accept what people actually have in front of them.
 *
 * The `/api/domains/:teamId/:domainId` routes — update, verify and delete —
 * take a NUMERIC id (`parseIdParam`, 400 otherwise). `domains list` printed
 * neither that nor the publicId until now, so the argument these three
 * commands need was the one thing the CLI would not tell you; a `dom_…` copied
 * from anywhere else came back "Invalid domain ID".
 *
 * So resolve here: a number passes through, and a `dom_…` publicId or the
 * hostname itself is looked up in the team's list. The hostname is the form
 * worth supporting most — it is what somebody is actually holding when they
 * want to verify or retire a domain.
 */
async function resolveDomainId(teamId: number, ref: string): Promise<number> {
	if (/^\d+$/.test(ref)) return Number(ref);

	const { domains } = await apiFetch<{ domains: Domain[] }>(`/api/domains/${teamId}`);
	const needle = ref.toLowerCase().replace(/\.$/, '');
	const match = domains.find((d) => d.publicId === ref || d.domain.toLowerCase() === needle);
	if (match) return match.id;

	console.error(red(`No domain matches "${ref}" on this team.`));
	if (domains.length > 0) {
		console.error(dim(`Domains here: ${domains.map((d) => d.domain).join(', ')}`));
	}
	process.exit(1);
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
				['Domain', 'ID', 'Status', 'Verified', 'Primary', 'Created'],
				domains.map((d) => [
					d.domain,
					d.publicId ?? String(d.id),
					statusBadge(d.status),
					// `status === 'active'` is the same test `domains verify`
					// applies to decide whether a check passed.
					d.status === 'active' || d.verifiedAt ? green('yes') : red('no'),
					d.isPrimary ? green('yes') : '',
					formatDate(d.createdAt),
				]),
			),
		);

		// The fallback below is silent and it is what breaks uptime checks:
		// with no primary nominated, the platform picks the OLDEST domain on
		// the service, which on a renamed host is the retired alias that now
		// 301s to the real one. Say so, with the fix attached.
		const byService = new Map<number, Domain[]>();
		for (const d of domains) {
			if (d.serviceId === undefined) continue;
			const bucket = byService.get(d.serviceId);
			if (bucket) bucket.push(d);
			else byService.set(d.serviceId, [d]);
		}
		const ambiguous = [...byService.values()].filter(
			(group) => group.length > 1 && !group.some((d) => d.isPrimary),
		);
		if (ambiguous.length > 0) {
			console.log();
			console.log(
				yellow(
					`${ambiguous.length} service${ambiguous.length === 1 ? '' : 's'} answer on several hostnames with no primary nominated.`,
				),
			);
			for (const group of ambiguous) {
				const oldest = [...group].sort(
					(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
				)[0]!;
				console.log(
					`  ${group.map((d) => d.domain).join(', ')} ${dim('→ falls back to')} ${bold(oldest.domain)}`,
				);
			}
			console.log(
				dim(
					'  That fallback is what ${service.url} resolves to and what the uptime check probes.',
				),
			);
			console.log(dim('  Nominate one: hoststack domains update <domain-id> --primary'));
		}
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
	const serviceRaw = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;
	const pathIdx = args.indexOf('--path-prefix');
	const pathPrefix = pathIdx !== -1 ? args[pathIdx + 1] : undefined;

	if (!domain || !serviceRaw) {
		console.log(
			`${bold('Usage:')} hoststack domains add <domain> --service <service-id|svc_…> [--path-prefix <prefix>]`,
		);
		console.log();
		console.log(dim('  --service is required: every custom domain must point at a service.'));
		process.exit(1);
	}

	const serviceId = await resolveServiceId(teamId, serviceRaw);

	const s = spinner('Adding domain...');

	try {
		const body: Record<string, unknown> = { domain, serviceId };
		if (pathPrefix) body.pathPrefix = pathPrefix;

		const result = await apiFetch<{ domain: Domain }>(`/api/domains/${teamId}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		s.stop('Domain added');
		console.log(`${green('+')} ${bold(result.domain.domain)}`);
		console.log();
		console.log(
			`Next: Verify DNS with ${dim(`hoststack domains verify ${result.domain.domain}`)}`,
		);
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
		console.log(`${bold('Usage:')} hoststack domains verify <hostname|dom_…|id>`);
		process.exit(1);
	}

	const numericId = await resolveDomainId(teamId, domainId);

	const s = spinner('Verifying DNS...');

	try {
		// The route returns the domain as it stands AFTER the check. This used to
		// discard it and print "Domain verified" on any 200 — i.e. it said
		// verified whenever the request succeeded, which is not the same thing
		// and is exactly the claim someone acts on during a cutover.
		const { domain } = await apiFetch<{
			domain: Domain & { delegationWarning?: string; dnsSyncWarning?: string };
		}>(`/api/domains/${teamId}/${numericId}/verify`, { method: 'POST' });

		if (domain.status === 'active') {
			s.stop(green(`Verified ${domain.domain}`));
			return;
		}

		if (domain.delegationWarning) {
			// A failure that retrying cannot fix: we host the zone, the records
			// are ours and correct, and the registry sends nobody here.
			s.stop(red(`${domain.domain} did not verify`));
			console.log();
			console.log(domain.delegationWarning);
			process.exit(1);
		}

		if (domain.dnsSyncWarning) {
			// Also not fixable by waiting, but this one is on our side of the
			// line: the record could not be published at all.
			s.stop(red(`${domain.domain} did not verify`));
			console.log();
			console.log(domain.dnsSyncWarning);
			process.exit(1);
		}

		s.stop(yellow(`${domain.domain} is still ${domain.status}`));
		console.log(
			dim('  DNS changes take time to propagate. Check the records resolve publicly,'),
		);
		console.log(dim('  then run this again.'));
		process.exit(1);
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
		console.log(`${bold('Usage:')} hoststack domains delete <hostname|dom_…|id>`);
		process.exit(1);
	}

	const numericId = await resolveDomainId(teamId, domainId);

	const s = spinner('Removing domain...');

	try {
		await apiFetch(`/api/domains/${teamId}/${numericId}`, { method: 'DELETE' });
		s.stop('Domain removed');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/**
 * Change a domain — most usefully, nominate it as the service's PRIMARY
 * hostname.
 *
 * Three parts of the platform have to pick ONE hostname when a service answers
 * on several: the address the service advertises to itself in `${service.url}`,
 * the host its uptime check probes, and the hostname on the monitoring page.
 * All three take the primary, and all three fall back to the OLDEST domain when
 * nothing is nominated — which on a renamed host is the retired alias, not the
 * canonical name.
 *
 * That is not hypothetical. On 2026-09-11, `wuckert.micci.dk` (added 25 Aug)
 * and `wohnwagen-wuckert.de` (added today) both sat on service 198 with no
 * primary. The uptime check kept probing the older one, which by then 301'd to
 * the new domain, and raised a critical `service.uptime_down` — "Expected HTTP
 * 200, got 301" — against a site that was serving perfectly. `set_uptime_check`
 * takes a path and never a host, so this is the only place that can be fixed.
 *
 * One primary per service: promoting a domain demotes its sibling in the same
 * write, so there is never a pair to choose between.
 */
async function updateDomain(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const domainId = args[0];
	const body: Record<string, unknown> = {};
	if (args.includes('--primary')) body.isPrimary = true;
	if (args.includes('--ssl')) body.sslEnabled = true;
	if (args.includes('--no-ssl')) body.sslEnabled = false;
	const redirectIdx = args.indexOf('--redirect');
	if (redirectIdx !== -1) {
		const url = args[redirectIdx + 1];
		if (url === undefined || url.startsWith('--')) {
			console.error(red('--redirect needs an absolute http(s) URL.'));
			process.exit(1);
		}
		body.redirectTo = url;
	}
	// Explicit null clears it. `--redirect ""` would be ambiguous with a shell
	// that ate the argument, so clearing gets its own flag.
	if (args.includes('--no-redirect')) body.redirectTo = null;

	if (!domainId || domainId.startsWith('--') || Object.keys(body).length === 0) {
		console.log(
			`${bold('Usage:')} hoststack domains update <hostname|dom_…|id> [--primary] [--ssl|--no-ssl] [--redirect <url>|--no-redirect]`,
		);
		console.log();
		console.log(dim('  --primary makes this the hostname ${service.url} resolves to, the one'));
		console.log(dim('  the uptime check probes, and the one the monitoring page shows. With'));
		console.log(dim('  none nominated all three fall back to the OLDEST domain, which on a'));
		console.log(dim('  renamed host is usually the alias that redirects.'));
		console.log();
		console.log(dim('  --ssl applies on the next deploy, which this triggers.'));
		process.exit(1);
	}
	if (args.includes('--ssl') && args.includes('--no-ssl')) {
		console.error(red('Pass --ssl or --no-ssl, not both.'));
		process.exit(1);
	}

	const numericId = await resolveDomainId(teamId, domainId);

	const s = spinner('Updating domain...');
	try {
		const { domain } = await apiFetch<{ domain: Domain }>(
			`/api/domains/${teamId}/${numericId}`,
			{ method: 'PATCH', body: JSON.stringify(body) },
		);
		s.stop('Updated');
		if (body.isPrimary === true) {
			console.log(
				`${bold(domain.domain)} is now the primary hostname for its service — what ${dim('${service.url}')} resolves to, and what the uptime check probes.`,
			);
			return;
		}
		console.log(bold(domain.domain));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
