import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatCount } from '../lib/format.ts';
import { bold, cyan, dim, green, handleError, red, table, yellow } from '../lib/output.ts';

interface AnalyticsSite {
	id: number;
	publicId: string;
	name: string;
	domain: string;
	ingestKey: string;
	previousIngestKey: string | null;
	keyGraceEndsAt: string | null;
	allowedOrigins: string[];
	serviceId: number | null;
	serviceName: string | null;
	retentionDays: number;
	droppedCount: number;
	lastEventAt: string | null;
	lastRefusalAt: string | null;
	lastRefusalReason: RefusalReason | null;
	refusedRecently: Record<RefusalReason, number>;
}

// The CLI is a standalone published package with no @hoststack/shared
// dependency, so these shapes are restated here rather than imported. Kept in
// the same order as ANALYTICS_REFUSAL_REASONS on the server.
type RefusalReason = 'unknown_key' | 'bad_origin' | 'bot' | 'over_quota';

interface SiteStatus {
	domain: string;
	ingestKey: string;
	allowedOrigins: string[];
	lastEventAt: string | null;
	lastRefusalAt: string | null;
	lastRefusalReason: RefusalReason | null;
	lastRefusalOrigin: string | null;
	refusedRecently: Record<RefusalReason, number>;
	refusedOrigins: Record<string, number>;
	droppedCount: number;
	quota: { usedThisHour: number; limitPerHour: number; hourResetsAt: string };
	health: 'receiving' | 'quiet' | 'refusing' | 'never';
	headline: string;
	detail: string;
}

interface MetricWindow {
	pageviews: number;
	visitors: number;
	bounceRate: number | null;
	avgDurationMs: number | null;
}

interface SiteSummary {
	siteId: number;
	name: string;
	domain: string;
	current: MetricWindow;
	previous: MetricWindow;
	live: number;
	visitorsAreSummedDailies: boolean;
}

interface Overview {
	range: string;
	source: 'raw' | 'rollup';
	visitorsAreSummedDailies: boolean;
	summary: { current: MetricWindow; previous: MetricWindow };
	topPaths: { path: string; pageviews: number }[];
	topReferrers: { referrer: string; visits: number }[];
	countries: { key: string; count: number }[];
	topEvents: { eventType: string; count: number }[];
}

/**
 * `hoststack analytics` — traffic for the sites a team owns.
 *
 * Deliberately not a reporting client: recording an event uses a write-only
 * site key posted to a documented HTTP endpoint, because that credential ships
 * inside a web page where anyone can read it.
 */
export async function analyticsCommand(args: string[]): Promise<void> {
	const subcommand = args[0];

	switch (subcommand) {
		case 'sites':
		case 'ls':
			return listSites(args.slice(1));
		case 'add':
			return addSite(args.slice(1));
		case 'set':
			return setSite(args.slice(1));
		case 'rm':
			return removeSite(args.slice(1));
		case 'rotate':
			return rotateKey(args.slice(1));
		case 'check':
			return checkSite(args.slice(1));
		case 'stats':
			return stats(args.slice(1));
		case 'snippet':
			return snippet(args.slice(1));
		case 'verify':
			return verifyDomain(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack analytics <command>`);
			console.log();
			console.log('Commands:');
			console.log('  sites [--json]                     Every site this team tracks');
			console.log('  add <domain> [--name <name>]       Start tracking a domain');
			console.log(
				'  set <domain> [--allowed-origins a,b] [--name <name>] [--retention <days>]',
			);
			console.log('  rm <domain>                        Delete a site and its data');
			console.log('  rotate <domain>                    New key; the old one lasts 30 days');
			console.log(
				'  check <domain> [--json]            Is it working? Answers without traffic',
			);
			console.log('  snippet <domain>                   The script tag to paste');
			console.log(
				'  verify <domain> [--check]          Prove you own it (needed for uptime)',
			);
			console.log('  stats [domain] [--range 7d] [--json]');
			console.log();
			console.log(
				`${dim('Ranges: 24h, 7d, 30d, 90d, 12mo. Omit the domain for every site.')}`,
			);
			console.log(
				dim('Analytics needs no verification. `verify` exists for uptime checks on a site'),
			);
			console.log(dim('HostStack does not host — see: hoststack uptime set --site <id>.'));
			process.exit(1);
	}
}

function requireTeam(): number {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	return teamId;
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx === -1 ? undefined : args[idx + 1];
}

function pct(value: number | null): string {
	return value == null ? '—' : `${value.toFixed(1)}%`;
}

function duration(ms: number | null): string {
	if (ms == null) return '—';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** "+12%" against the previous period, or "—" when there is nothing to compare. */
function delta(current: number, previous: number): string {
	if (previous === 0) return current === 0 ? '—' : green('new');
	const change = ((current - previous) / previous) * 100;
	const text = `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`;
	return change >= 0 ? green(text) : red(text);
}

async function resolveSite(teamId: number, domain: string): Promise<AnalyticsSite> {
	const { sites } = await apiFetch<{ sites: AnalyticsSite[] }>(`/api/analytics/${teamId}/sites`);
	const needle = domain.toLowerCase();
	const site = sites.find((s) => s.domain === needle || s.publicId === domain);
	if (!site) {
		console.error(red(`No site for ${domain}. Add it with: hoststack analytics add ${domain}`));
		process.exit(1);
	}
	return site;
}

async function listSites(args: string[]): Promise<void> {
	const teamId = requireTeam();
	try {
		const data = await apiFetch<{ sites: AnalyticsSite[] }>(`/api/analytics/${teamId}/sites`);
		if (args.includes('--json')) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}
		if (data.sites.length === 0) {
			console.log(dim('No sites yet. Add one: hoststack analytics add example.com'));
			return;
		}
		console.log(
			table(
				['Domain', 'Name', 'Service', 'Raw retention', 'Last event', 'Key'],
				data.sites.map((s) => [
					s.domain,
					s.name,
					s.serviceName ?? dim('—'),
					`${s.retentionDays}d`,
					// A site that has never reported reads as "never", not as a
					// blank cell — the whole failure this column exists for is
					// one that looks like an absence of information.
					s.lastEventAt ? s.lastEventAt : red('never'),
					s.ingestKey,
				]),
			),
		);
		const rotating = data.sites.filter((s) => s.previousIngestKey);
		for (const s of rotating) {
			console.log(
				yellow(
					`${s.domain}: an older key still works until ${s.keyGraceEndsAt ?? 'soon'} — deploy the new snippet before then.`,
				),
			);
		}
		for (const s of data.sites.filter((site) => blockingRefusals(site.refusedRecently) > 0)) {
			console.log(
				yellow(
					`${s.domain}: ${formatCount(blockingRefusals(s.refusedRecently))} events were refused in the last 7 days (${s.lastRefusalReason ?? 'unknown'}). Run: hoststack analytics check ${s.domain}`,
				),
			);
		}
		const dropping = data.sites.filter((s) => s.droppedCount > 0);
		for (const s of dropping) {
			console.log(
				yellow(
					`${s.domain}: ${formatCount(s.droppedCount)} events were refused by the hourly quota and are missing from its counts.`,
				),
			);
		}
	} catch (error) {
		handleError(error);
	}
}

/** Bot refusals are the filter working; only these three mean something is wrong. */
function blockingRefusals(counts: Record<RefusalReason, number> | undefined): number {
	if (!counts) return 0;
	return (counts.unknown_key ?? 0) + (counts.bad_origin ?? 0) + (counts.over_quota ?? 0);
}

/**
 * `hoststack analytics check <domain>` — the answer to "why is this showing
 * zero", without having to generate traffic and guess.
 *
 * Ingest answers 204 to a real key and to a typo alike, which is correct and
 * also why five completely different situations — stale key, disallowed origin,
 * blown quota, events blocked in the browser, and simply no visitors yet — all
 * rendered as one empty chart. This prints which of them it is.
 */
async function checkSite(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(red('Usage: hoststack analytics check <domain>'));
		process.exit(1);
	}
	try {
		const site = await resolveSite(teamId, domain);
		const status = await apiFetch<SiteStatus>(
			`/api/analytics/${teamId}/sites/${site.id}/status`,
		);
		if (args.includes('--json')) {
			console.log(JSON.stringify(status, null, 2));
			return;
		}

		const tone =
			status.health === 'receiving' ? green : status.health === 'quiet' ? yellow : red;
		console.log(`${tone(status.headline)} ${bold(status.domain)}`);
		console.log(status.detail);
		console.log();
		console.log(`${dim('Site key   ')} ${status.ingestKey}`);
		console.log(
			`${dim('Origins    ')} ${[status.domain, `*.${status.domain}`, ...status.allowedOrigins].join(', ')}`,
		);
		console.log(`${dim('Last event ')} ${status.lastEventAt ?? red('never')}`);
		if (status.lastRefusalAt) {
			console.log(
				`${dim('Last refusal')} ${status.lastRefusalAt} · ${status.lastRefusalReason}${
					status.lastRefusalOrigin ? ` · from ${status.lastRefusalOrigin}` : ''
				}`,
			);
		}
		const refused = Object.entries(status.refusedRecently)
			.filter(([, count]) => count > 0)
			.map(([reason, count]) => `${reason} ${formatCount(count)}`);
		console.log(`${dim('Refused 7d ')} ${refused.length > 0 ? refused.join(' · ') : 'none'}`);
		// The origins behind the bad_origin refusals, which is the only part of
		// the tally there is an action for. `Last refusal` above names the
		// newest refusal of ANY reason, so it is usually a bot's origin.
		const badOrigins = Object.entries(status.refusedOrigins ?? {}).sort((a, b) => b[1] - a[1]);
		if (badOrigins.length > 0) {
			console.log(
				`${dim('Refused by origin')} ${badOrigins
					.map(([origin, count]) => `${origin} ${formatCount(count)}`)
					.join(' · ')}`,
			);
			console.log(
				cyan(
					`  If yours: hoststack analytics set ${status.domain} --allowed-origins ${badOrigins
						.map(([origin]) => origin)
						.join(',')}`,
				),
			);
		}
		console.log(
			`${dim('Quota      ')} ${formatCount(status.quota.usedThisHour)} / ${formatCount(status.quota.limitPerHour)} this hour`,
		);
		if (status.health === 'never') {
			console.log();
			console.log(
				cyan(
					'Add data-debug to the script tag and reload the page: the tracker then logs the endpoint it resolved and every accepted 204 to the console.',
				),
			);
		}
	} catch (error) {
		handleError(error);
	}
}

async function addSite(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(red('Usage: hoststack analytics add <domain> [--name <name>]'));
		process.exit(1);
	}
	const name = flag(args, '--name');
	try {
		const site = await apiFetch<AnalyticsSite>(`/api/analytics/${teamId}/sites`, {
			method: 'POST',
			body: JSON.stringify({ domain, ...(name ? { name } : {}) }),
		});
		console.log(green(`Tracking ${site.domain}.`));
		console.log();
		printSnippet(site);
	} catch (error) {
		handleError(error);
	}
}

/**
 * Change a site after creation — most often its allowed origins.
 *
 * `check` reports `bad_origin` refusals and names the origin that was turned
 * away, but until this existed there was no way to act on that answer outside
 * the dashboard: the API and SDK both took `allowedOrigins`, and neither the
 * CLI nor MCP offered it.
 *
 * `--allowed-origins` REPLACES the list, so print the current one and say so
 * rather than letting a one-item flag silently discard the rest.
 */
async function setSite(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(
			red(
				'Usage: hoststack analytics set <domain> [--allowed-origins a,b] [--name <name>] [--retention <days>]',
			),
		);
		process.exit(1);
	}

	const originsRaw = flag(args, '--allowed-origins');
	const name = flag(args, '--name');
	const retentionRaw = flag(args, '--retention');

	const patch: Record<string, unknown> = {};
	if (originsRaw !== undefined) {
		// `--allowed-origins ""` is how you clear the list.
		patch['allowedOrigins'] = originsRaw
			.split(',')
			.map((o) => o.trim())
			.filter((o) => o.length > 0);
	}
	if (name !== undefined) patch['name'] = name;
	if (retentionRaw !== undefined) {
		const days = Number.parseInt(retentionRaw, 10);
		if (Number.isNaN(days) || days < 1) {
			console.error(red('--retention takes a whole number of days.'));
			process.exit(1);
		}
		patch['retentionDays'] = days;
	}
	if (Object.keys(patch).length === 0) {
		console.error(red('Nothing to change. Pass --allowed-origins, --name or --retention.'));
		process.exit(1);
	}

	try {
		const site = await resolveSite(teamId, domain);
		const updated = await apiFetch<AnalyticsSite>(`/api/analytics/${teamId}/sites/${site.id}`, {
			method: 'PATCH',
			body: JSON.stringify(patch),
		});
		console.log(green(`Updated ${updated.domain}.`));
		console.log(
			`${dim('Origins    ')} ${[updated.domain, `*.${updated.domain}`, ...updated.allowedOrigins].join(', ')}`,
		);
	} catch (error) {
		handleError(error);
	}
}

async function removeSite(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(red('Usage: hoststack analytics rm <domain>'));
		process.exit(1);
	}
	try {
		const site = await resolveSite(teamId, domain);
		await apiFetch(`/api/analytics/${teamId}/sites/${site.id}`, { method: 'DELETE' });
		console.log(green(`Deleted ${site.domain} and every event recorded for it.`));
	} catch (error) {
		handleError(error);
	}
}

async function rotateKey(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(red('Usage: hoststack analytics rotate <domain>'));
		process.exit(1);
	}
	try {
		const existing = await resolveSite(teamId, domain);
		const site = await apiFetch<AnalyticsSite>(
			`/api/analytics/${teamId}/sites/${existing.id}/rotate-key`,
			{ method: 'POST' },
		);
		console.log(green('New key issued. The previous one keeps working for 30 days.'));
		console.log();
		printSnippet(site);
	} catch (error) {
		handleError(error);
	}
}

function printSnippet(site: AnalyticsSite): void {
	console.log(bold('Paste this into your <head>:'));
	console.log(
		cyan(
			`<script defer src="https://hoststack.dev/t.js" data-site-key="${site.ingestKey}"></script>`,
		),
	);
}

async function snippet(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(red('Usage: hoststack analytics snippet <domain>'));
		process.exit(1);
	}
	try {
		printSnippet(await resolveSite(teamId, domain));
	} catch (error) {
		handleError(error);
	}
}

async function stats(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const range = flag(args, '--range') ?? '7d';
	const domain = args[0]?.startsWith('--') ? undefined : args[0];

	try {
		if (!domain) return await allSitesTable(teamId, range, args.includes('--json'));

		const site = await resolveSite(teamId, domain);
		const data = await apiFetch<Overview>(
			`/api/analytics/${teamId}/overview?range=${range}&siteIds=${site.id}`,
		);
		if (args.includes('--json')) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		const { current, previous } = data.summary;
		console.log(bold(`${site.domain} · ${range}`));
		console.log();
		console.log(
			table(
				[
					data.visitorsAreSummedDailies ? 'Daily visitors' : 'Visitors',
					'Pageviews',
					'Bounce',
					'Avg visit',
				],
				[
					[
						`${formatCount(current.visitors)} ${delta(current.visitors, previous.visitors)}`,
						`${formatCount(current.pageviews)} ${delta(current.pageviews, previous.pageviews)}`,
						pct(current.bounceRate),
						duration(current.avgDurationMs),
					],
				],
			),
		);

		if (data.visitorsAreSummedDailies) {
			console.log();
			console.log(
				dim(
					'This range reaches past the raw-event window, so visitors are each day’s uniques added together — a daily reader counts once per day.',
				),
			);
		}

		printTop(
			'Top paths',
			data.topPaths.map((r) => [r.path, String(r.pageviews)]),
		);
		printTop(
			'Top referrers',
			data.topReferrers.map((r) => [r.referrer, String(r.visits)]),
		);
		printTop(
			'Countries',
			data.countries.map((r) => [r.key, String(r.count)]),
		);
		printTop(
			'Events',
			data.topEvents.map((r) => [r.eventType, String(r.count)]),
		);
	} catch (error) {
		handleError(error);
	}
}

function printTop(title: string, rows: string[][]): void {
	if (rows.length === 0) return;
	console.log();
	console.log(bold(title));
	console.log(table(['', 'Count'], rows.slice(0, 10)));
}

async function allSitesTable(teamId: number, range: string, json: boolean): Promise<void> {
	const data = await apiFetch<{ range: string; sites: SiteSummary[] }>(
		`/api/analytics/${teamId}/summary?range=${range}`,
	);
	if (json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	if (data.sites.length === 0) {
		console.log(dim('No sites yet. Add one: hoststack analytics add example.com'));
		return;
	}
	const summed = data.sites.some((s) => s.visitorsAreSummedDailies);
	console.log(
		table(
			['Site', summed ? 'Daily visitors' : 'Visitors', 'Pageviews', 'Bounce', 'Live'],
			data.sites.map((s) => [
				s.domain,
				`${formatCount(s.current.visitors)} ${delta(s.current.visitors, s.previous.visitors)}`,
				`${formatCount(s.current.pageviews)} ${delta(s.current.pageviews, s.previous.pageviews)}`,
				pct(s.current.bounceRate),
				s.live > 0 ? green(String(s.live)) : dim('—'),
			]),
		),
	);
	console.log();
	console.log(
		dim(
			'Visitors are counted per site. The same person on two of your domains is two visitors — joining them would mean tracking across domains.',
		),
	);
}

/**
 * `hoststack analytics verify <domain> [--check]`
 *
 * Two steps on purpose. Without `--check` it prints the record to publish and
 * changes nothing; with `--check` it reads DNS and reports the verdict. The
 * token is stable between the two, so running the first command twice while
 * you find the registrar's DNS page does not invalidate what you already
 * pasted.
 *
 * Analytics itself never needs this — the ingest key only labels events the
 * site posts about itself. It gates the things that make the PLATFORM act on
 * the hostname, which today means uptime checks.
 */
async function verifyDomain(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const domain = args[0];
	if (!domain) {
		console.error(red('Usage: hoststack analytics verify <domain> [--check]'));
		process.exit(1);
	}

	try {
		const site = await resolveSite(teamId, domain);
		const proof = await apiFetch<{
			recordName: string;
			recordType: string;
			recordValue: string;
			verified: boolean;
		}>(`/api/analytics/${teamId}/sites/${site.id}/verification`);

		if (!args.includes('--check')) {
			if (proof.verified) {
				console.log(green(`${site.domain} is already verified.`));
				return;
			}
			console.log(`Publish this DNS record, then re-run with ${bold('--check')}:`);
			console.log();
			console.log(`  ${bold('Name')}   ${proof.recordName}`);
			console.log(`  ${bold('Type')}   ${proof.recordType}`);
			console.log(`  ${bold('Value')}  ${proof.recordValue}`);
			console.log();
			console.log(dim('The bare token on its own is accepted too, if your registrar'));
			console.log(dim('will not let you paste a key=value string.'));
			return;
		}

		const result = await apiFetch<{ verified: boolean; detail?: string }>(
			`/api/analytics/${teamId}/sites/${site.id}/verify`,
			{ method: 'POST', body: JSON.stringify({}) },
		);
		if (result.verified) {
			console.log(green(`${site.domain} verified.`));
			console.log(dim(`Watch it: hoststack uptime set --site ${site.id} --path /`));
			return;
		}
		console.log(yellow(`Not verified yet — ${result.detail ?? 'the record was not found'}.`));
		console.log(dim('DNS can take a few minutes to publish. Re-run to check again.'));
	} catch (error) {
		handleError(error);
	}
}
