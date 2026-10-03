import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDate } from '../lib/format.ts';
import { bold, cyan, dim, green, handleError, red, spinner, table, yellow } from '../lib/output.ts';

/**
 * Authoritative DNS from the terminal.
 *
 * The API and the MCP have had a full DNS surface for months; the CLI had no
 * `dns` command at all, so anyone driving HostStack from a shell could not read
 * a zone, let alone edit a record — they had to open the dashboard. This closes
 * that, and adds the one thing neither of the other two had: `dns check`, which
 * compares the nameservers we publish for a zone against the ones the parent
 * registry actually names.
 */

interface DnsZone {
	id: number;
	publicId: string;
	domainName: string;
	status: string;
	provider?: string;
	nsRecords?: string[];
	delegationStatus?: 'delegated' | 'foreign' | 'unknown';
	delegationObservedNs?: string[];
	delegationCheckedAt?: string | null;
	createdAt?: string;
}

interface DnsRecord {
	id: number;
	publicId: string;
	zoneId: number;
	type: string;
	name: string;
	value: string;
	ttl?: number;
	priority?: number | null;
	status?: string;
	managedBy?: string;
	createdAt?: string;
}

interface DelegationCheck {
	status: 'delegated' | 'foreign' | 'unknown';
	observedNameservers: string[];
	expectedNameservers: string[];
	checkedAt: string;
}

export async function dnsCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'zones';

	switch (subcommand) {
		case 'zones':
		case 'zone':
		case 'ls':
			return listZones(args.slice(1));
		case 'check':
			return checkDelegation(args.slice(1));
		case 'records':
		case 'list':
			return listRecords(args.slice(1));
		case 'add':
		case 'create':
			return addRecord(args.slice(1));
		case 'update':
		case 'edit':
			return updateRecord(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteRecord(args.slice(1));
		case 'resync':
			return resyncRecord(args.slice(1));
		default:
			printUsage();
			process.exit(1);
	}
}

function printUsage(): void {
	console.log(`${bold('Usage:')} hoststack dns <command>`);
	console.log();
	console.log('Commands:');
	console.log('  zones [--json]                             List hosted DNS zones');
	console.log(
		'  check <zone|domain>                       Is the registry actually pointing here?',
	);
	console.log('  records <zone|domain> [--json]            List records in a zone');
	console.log(
		'  add <zone|domain> <type> <name> <value> [--ttl N] [--priority N]   Create a record',
	);
	console.log(
		'  update <record-id> <type> <name> <value> [--ttl N] [--priority N]  Replace a record',
	);
	console.log('  delete <record-id>                        Delete a record');
	console.log('  resync <record-id>                        Re-push a record stuck "failed"');
	console.log();
	console.log(dim('  <zone|domain> accepts a zone id (dnz_…) or any name under it.'));
	console.log(dim('  <name> is "@" for the apex or a bare label ("www"); no zone suffix.'));
	console.log();
	console.log(`${bold('Examples:')}`);
	console.log(dim('  hoststack dns zones'));
	console.log(dim('  hoststack dns check example.com'));
	console.log(dim('  hoststack dns add example.com A www 203.0.113.10 --ttl 300'));
	console.log(dim('  hoststack dns add example.com MX @ mail.example.com --priority 10'));
}

function requireTeam(): number | string {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	return teamId;
}

/**
 * Accept a zone publicId or any hostname under the zone, same longest-suffix
 * match the API and MCP use — `app.example.com` finds the `example.com` zone.
 * Typing the apex you are working on is the natural thing to do; making that an
 * error would be the CLI's own invention.
 */
async function resolveZone(teamId: number | string, ref: string): Promise<DnsZone> {
	const { zones } = await apiFetch<{ zones: DnsZone[] }>(`/api/dns-zones/${teamId}`);
	const byId = zones.find((z) => z.publicId === ref);
	if (byId) return byId;

	const fqdn = ref.toLowerCase().replace(/\.$/, '');
	const labels = fqdn.split('.');
	for (let i = 0; i < labels.length - 1; i++) {
		const candidate = labels.slice(i).join('.');
		const match = zones.find(
			(z) => z.domainName.toLowerCase() === candidate && z.status !== 'deleting',
		);
		if (match) return match;
	}

	console.error(red(`No hosted zone matches "${ref}".`));
	if (zones.length > 0) {
		console.error(dim(`Zones on this team: ${zones.map((z) => z.domainName).join(', ')}`));
	} else {
		console.error(dim('This team hosts no DNS zones yet.'));
	}
	process.exit(1);
}

/**
 * Records have no GET-by-id route, so find the owning zone by scanning. Zone
 * count per team is small (tier-capped), so this is two round-trips in the
 * common case and never more than a handful.
 */
async function findRecord(
	teamId: number | string,
	recordId: string,
): Promise<{ zone: DnsZone; record: DnsRecord }> {
	const { zones } = await apiFetch<{ zones: DnsZone[] }>(`/api/dns-zones/${teamId}`);
	for (const zone of zones) {
		const { records } = await apiFetch<{ records: DnsRecord[] }>(
			`/api/dns-zones/${teamId}/${zone.publicId}/records`,
		);
		const match = records.find((r) => r.publicId === recordId);
		if (match) return { zone, record: match };
	}
	console.error(red(`Record ${recordId} not found on any zone owned by this team.`));
	process.exit(1);
}

/** One-word rendering of a delegation state, coloured by how much it matters. */
function delegationBadge(status: DnsZone['delegationStatus']): string {
	if (status === 'delegated') return green('delegated');
	if (status === 'foreign') return red('ELSEWHERE');
	return dim('unknown');
}

async function listZones(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const jsonFlag = args.includes('--json');

	try {
		const { zones } = await apiFetch<{ zones: DnsZone[] }>(`/api/dns-zones/${teamId}`);

		if (jsonFlag) {
			console.log(JSON.stringify(zones, null, 2));
			return;
		}
		if (zones.length === 0) {
			console.log(dim('No hosted DNS zones on this team.'));
			return;
		}

		console.log(
			table(
				['Zone', 'ID', 'Status', 'Delegation', 'Checked'],
				zones.map((z) => [
					z.domainName,
					z.publicId,
					z.status,
					delegationBadge(z.delegationStatus),
					z.delegationCheckedAt ? formatDate(z.delegationCheckedAt) : dim('never'),
				]),
			),
		);

		// The whole point of the column: a zone we host that the registry sends
		// nobody to looks healthy in every other cell of this table. Spell it out
		// under the table, naming who the traffic currently goes to, because "a
		// red word in a column" is not an instruction.
		const foreign = zones.filter((z) => z.delegationStatus === 'foreign');
		if (foreign.length > 0) {
			console.log();
			console.log(
				yellow(
					`${foreign.length} zone${foreign.length === 1 ? '' : 's'} hosted here but delegated elsewhere:`,
				),
			);
			for (const z of foreign) {
				const observed = (z.delegationObservedNs ?? []).join(', ') || 'unknown nameservers';
				console.log(`  ${bold(z.domainName)} ${dim('→')} ${observed}`);
			}
			console.log(
				dim(
					'  Records in these zones are correct but unreachable. Change the nameservers at the registrar.',
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

async function checkDelegation(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const ref = args[0];
	if (!ref) {
		console.log(`${bold('Usage:')} hoststack dns check <zone|domain> [--json]`);
		process.exit(1);
	}
	const jsonFlag = args.includes('--json');

	try {
		const zone = await resolveZone(teamId, ref);
		const s = jsonFlag ? null : spinner(`Reading the delegation for ${zone.domainName}...`);
		const { delegation } = await apiFetch<{ delegation: DelegationCheck }>(
			`/api/dns-zones/${teamId}/${zone.publicId}/delegation/check`,
			{ method: 'POST' },
		);

		if (jsonFlag) {
			console.log(JSON.stringify({ zone: zone.domainName, delegation }, null, 2));
			return;
		}

		const observed = delegation.observedNameservers.join(', ');
		const expected = delegation.expectedNameservers.join(', ');

		if (delegation.status === 'delegated') {
			s?.stop(green(`${zone.domainName} is delegated to HostStack`));
			console.log(`  ${dim('registry points at')} ${observed}`);
			console.log(`  ${dim('queries for this zone reach us')}`);
			return;
		}

		if (delegation.status === 'foreign') {
			s?.stop(red(`${zone.domainName} is NOT delegated to HostStack`));
			console.log(`  ${dim('registry points at')} ${bold(observed)}`);
			console.log(`  ${dim('should point at  ')} ${bold(expected)}`);
			console.log();
			console.log(
				'This zone is hosted here and its records are correct, but nothing is being',
			);
			console.log(
				'sent to read them — public lookups still answer from the nameservers above.',
			);
			console.log(
				`Change the nameservers at the registrar of ${bold(zone.domainName)}, then run this again.`,
			);
			console.log(dim('Delegation changes can take up to 48 hours to propagate.'));
			// Exit non-zero so this is usable as a cutover gate in a script. A
			// zone that serves nobody is a failure, whatever the dashboard says.
			process.exit(1);
		}

		s?.stop(yellow(`Could not determine the delegation for ${zone.domainName}`));
		console.log(
			dim(
				'  The NS lookup returned no usable answer (SERVFAIL, timeout, or not registered).',
			),
		);
		console.log(
			dim(
				'  This is NOT evidence the delegation is wrong — do not change a registrar on it.',
			),
		);
		// Deliberately exit 0: "we could not find out" is not a finding, and a
		// script that treats it as one fails on a resolver blip.
	} catch (err) {
		handleError(err);
	}
}

async function listRecords(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const ref = args[0];
	if (!ref) {
		console.log(`${bold('Usage:')} hoststack dns records <zone|domain> [--json]`);
		process.exit(1);
	}
	const jsonFlag = args.includes('--json');

	try {
		const zone = await resolveZone(teamId, ref);
		const { records } = await apiFetch<{ records: DnsRecord[] }>(
			`/api/dns-zones/${teamId}/${zone.publicId}/records`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(records, null, 2));
			return;
		}
		if (records.length === 0) {
			console.log(dim(`Zone ${zone.domainName} has no records yet.`));
			return;
		}

		console.log(`${bold(zone.domainName)} ${dim(zone.publicId)}`);
		console.log();
		console.log(
			table(
				['ID', 'Type', 'Name', 'Value', 'TTL', 'Status'],
				records.map((r) => [
					r.publicId,
					r.type,
					r.name,
					r.priority != null ? `${r.priority} ${r.value}` : r.value,
					String(r.ttl ?? ''),
					r.status === 'failed' ? red(r.status) : (r.status ?? ''),
				]),
			),
		);

		const failed = records.filter((r) => r.status === 'failed');
		if (failed.length > 0) {
			console.log();
			console.log(
				dim(
					`${failed.length} record${failed.length === 1 ? '' : 's'} failed to sync — re-push with: hoststack dns resync <record-id>`,
				),
			);
		}
	} catch (err) {
		handleError(err);
	}
}

/** `--ttl` / `--priority`, parsed strictly: a typo must not become a silent default. */
function numericFlag(args: string[], flag: string): number | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	const raw = args[idx + 1];
	const parsed = Number(raw);
	if (!raw || !Number.isInteger(parsed)) {
		console.error(red(`${flag} needs a whole number (got ${raw ?? 'nothing'}).`));
		process.exit(1);
	}
	return parsed;
}

/** Positional args, with flags and their values removed. */
function positionals(args: string[], valueFlags: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (valueFlags.includes(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith('--')) continue;
		out.push(arg);
	}
	return out;
}

const VALUE_FLAGS = ['--ttl', '--priority'];

function recordBody(
	type: string,
	name: string,
	value: string,
	args: string[],
): Record<string, unknown> {
	const ttl = numericFlag(args, '--ttl');
	const priority = numericFlag(args, '--priority');
	// MX and SRV carry priority on the wire and the API rejects them without it.
	// Catch it here so the message names the flag rather than echoing a 400.
	const upper = type.toUpperCase();
	if ((upper === 'MX' || upper === 'SRV') && priority === undefined) {
		console.error(red(`${upper} records need --priority <0-65535>.`));
		process.exit(1);
	}
	const body: Record<string, unknown> = { type: upper, name, value };
	if (ttl !== undefined) body.ttl = ttl;
	if (priority !== undefined) body.priority = priority;
	return body;
}

async function addRecord(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const [ref, type, name, value] = positionals(args, VALUE_FLAGS);
	if (!ref || !type || !name || !value) {
		console.log(
			`${bold('Usage:')} hoststack dns add <zone|domain> <type> <name> <value> [--ttl N] [--priority N]`,
		);
		console.log();
		console.log(dim('  hoststack dns add example.com A www 203.0.113.10 --ttl 300'));
		console.log(dim('  hoststack dns add example.com TXT @ "v=spf1 -all"'));
		process.exit(1);
	}

	try {
		const zone = await resolveZone(teamId, ref);
		const s = spinner(`Creating ${type.toUpperCase()} ${name} on ${zone.domainName}...`);
		try {
			const { record } = await apiFetch<{ record: DnsRecord }>(
				`/api/dns-zones/${teamId}/${zone.publicId}/records`,
				{ method: 'POST', body: JSON.stringify(recordBody(type, name, value, args)) },
			);
			s.stop(green(`Created ${record.type} ${record.name} on ${zone.domainName}`));
			console.log(`  ${dim('id')}     ${record.publicId}`);
			console.log(`  ${dim('value')}  ${record.value}`);
			console.log(`  ${dim('status')} ${record.status ?? 'syncing'}`);
		} catch (err) {
			s.stop(red('Failed'));
			handleError(err);
		}
	} catch (err) {
		handleError(err);
	}
}

async function updateRecord(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const [recordId, type, name, value] = positionals(args, VALUE_FLAGS);
	if (!recordId || !type || !name || !value) {
		console.log(
			`${bold('Usage:')} hoststack dns update <record-id> <type> <name> <value> [--ttl N] [--priority N]`,
		);
		console.log();
		console.log(
			dim('  Full replace, not a patch: every field is written. Read the current one'),
		);
		console.log(dim('  first with: hoststack dns records <zone>'));
		process.exit(1);
	}

	try {
		const { zone } = await findRecord(teamId, recordId);
		const s = spinner(`Updating ${recordId}...`);
		try {
			const { record } = await apiFetch<{ record: DnsRecord }>(
				`/api/dns-zones/${teamId}/${zone.publicId}/records/${recordId}`,
				{ method: 'PUT', body: JSON.stringify(recordBody(type, name, value, args)) },
			);
			s.stop(green(`Updated ${record.type} ${record.name} on ${zone.domainName}`));
			console.log(`  ${dim('value')}  ${record.value}`);
			console.log(`  ${dim('status')} ${record.status ?? 'syncing'}`);
		} catch (err) {
			s.stop(red('Failed'));
			handleError(err);
		}
	} catch (err) {
		handleError(err);
	}
}

async function deleteRecord(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const recordId = args[0];
	if (!recordId) {
		console.log(`${bold('Usage:')} hoststack dns delete <record-id>`);
		process.exit(1);
	}

	try {
		const { zone, record } = await findRecord(teamId, recordId);
		const s = spinner(`Deleting ${record.type} ${record.name} from ${zone.domainName}...`);
		try {
			await apiFetch(`/api/dns-zones/${teamId}/${zone.publicId}/records/${recordId}`, {
				method: 'DELETE',
			});
			s.stop(green(`Deleted ${record.type} ${record.name} from ${zone.domainName}`));
			console.log(dim('  Resolvers stop returning the value as the change propagates.'));
		} catch (err) {
			s.stop(red('Failed'));
			handleError(err);
		}
	} catch (err) {
		handleError(err);
	}
}

async function resyncRecord(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const recordId = args[0];
	if (!recordId) {
		console.log(`${bold('Usage:')} hoststack dns resync <record-id>`);
		console.log();
		console.log(dim('  Re-pushes a record to the nameservers without changing its value.'));
		console.log(dim('  Use on a record stuck at status "failed" after a provider blip.'));
		process.exit(1);
	}

	try {
		const { zone } = await findRecord(teamId, recordId);
		const s = spinner(`Re-syncing ${recordId}...`);
		try {
			const { record } = await apiFetch<{ record: DnsRecord }>(
				`/api/dns-zones/${teamId}/${zone.publicId}/records/${recordId}/resync`,
				{ method: 'POST' },
			);
			const ok = record.status === 'active';
			s.stop(
				ok
					? green(`Re-synced ${record.type} ${record.name} — now active`)
					: yellow(`Re-synced ${recordId}, status is ${record.status}`),
			);
			if (!ok) {
				console.log(
					dim(
						`  Still not active. Check the zone's provider status: ${cyan('hoststack dns zones')}`,
					),
				);
			}
		} catch (err) {
			s.stop(red('Failed'));
			handleError(err);
		}
	} catch (err) {
		handleError(err);
	}
}
