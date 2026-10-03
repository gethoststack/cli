import { apiFetch } from '../lib/api.ts';
import { APP_TEMPLATES } from '../lib/catalog.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDate, formatDateTime } from '../lib/format.ts';
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
import { resolveProjectId } from '../lib/resolve.ts';
import { machineIdFromFlag } from './machines.ts';

interface Service {
	id: number;
	publicId: string;
	name: string;
	type: string;
	status: string;
	internalUrl?: string | null;
	projectId: number;
	createdAt: string;
	// Repo wiring. A service points at ONE of these: gitRepoUrl for a plain
	// git remote, or the id of a row in that provider's repos table. There is
	// no repo URL on the row for a connected provider, which is why --repo has
	// to resolve the ids (see repoKeysForServices).
	branch?: string | null;
	autoDeploy?: boolean;
	gitRepoUrl?: string | null;
	githubRepoId?: number | null;
	gitlabRepoId?: number | null;
	bitbucketRepoId?: number | null;
	codebergRepoId?: number | null;
}

interface ProviderRepo {
	id: number;
	fullName?: string | null;
	cloneUrl?: string | null;
	htmlUrl?: string | null;
	webUrl?: string | null;
}

const REPO_PROVIDERS = [
	{ key: 'githubRepoId', path: 'github' },
	{ key: 'gitlabRepoId', path: 'gitlab' },
	{ key: 'bitbucketRepoId', path: 'bitbucket' },
	{ key: 'codebergRepoId', path: 'codeberg' },
] as const;

/**
 * Normalise a repo reference so the forms people actually type all compare
 * equal: an SSH remote, an HTTPS clone URL, a browser URL, and a bare
 * "owner/name". Mirrors the ORIGIN_KEY normalisation in the dev box's
 * `dev-ship`, which is the main caller of --repo.
 */
function repoKey(ref: string): string {
	let v = ref.trim().replace(/^git\+/, '');
	v = v.replace(/^ssh:\/\//, '');
	v = v.replace(/^([^@/\s]+)@([^:/\s]+):/, 'https://$2/');
	v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	v = v.replace(/\.git$/, '').replace(/\/+$/, '');
	// "owner/name" and "github.com/owner/name" must match: keep the last two
	// path segments, which is the repo's identity on every provider we speak.
	const parts = v.split('/').filter(Boolean);
	return parts.slice(-2).join('/').toLowerCase();
}

/**
 * The set of repo keys each service builds from, resolving provider repo ids
 * to URLs. Only providers actually referenced by `services` are fetched, so a
 * GitHub-only team pays exactly one extra request.
 */
async function repoKeysForServices(
	teamId: string | number,
	services: Service[],
): Promise<Map<number, string>> {
	const byService = new Map<number, string>();
	const needed = new Set<string>();

	for (const s of services) {
		if (s.gitRepoUrl) {
			byService.set(s.id, repoKey(s.gitRepoUrl));
			continue;
		}
		for (const { key, path } of REPO_PROVIDERS) {
			if (s[key]) needed.add(path);
		}
	}

	for (const path of needed) {
		let repos: ProviderRepo[];
		try {
			const data = await apiFetch<{ repos: ProviderRepo[] }>(`/api/${path}/${teamId}/repos`);
			repos = data.repos ?? [];
		} catch {
			// A provider the team has not connected (or cannot reach) simply
			// contributes no matches. Leaving those services unresolved is
			// honest; failing the whole listing over it is not.
			continue;
		}
		const byId = new Map(repos.map((r) => [r.id, r]));
		const field = REPO_PROVIDERS.find((p) => p.path === path)!.key;
		for (const s of services) {
			const id = s[field];
			if (!id || byService.has(s.id)) continue;
			const repo = byId.get(id);
			const ref = repo?.cloneUrl ?? repo?.htmlUrl ?? repo?.webUrl ?? repo?.fullName;
			if (ref) byService.set(s.id, repoKey(ref));
		}
	}

	return byService;
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
		case 'update':
		case 'config':
			return updateService(args.slice(1));
		case 'metrics':
			return serviceMetrics(args.slice(1));
		case 'templates':
			return listTemplates(args.slice(1));
		case 'link':
			return linkResource(args.slice(1));
		case 'links':
			return listResourceLinks(args.slice(1));
		case 'unlink':
			return unlinkResource(args.slice(1));
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
			console.log('  scale <id> <min[:max]>   Scale to N or autoscale min..max');
			console.log('  update <id> [flags]      Change build/runtime config');
			console.log('  metrics <id> [--history] CPU, memory against its limit, disk, network');
			console.log('  templates                Quickstart ids for create --template');
			console.log();
			console.log('Linking managed resources into a service:');
			console.log('  links <id>               What is injected into it today');
			console.log(
				'  link <id> --type <t> --resource <n> --alias <PREFIX>   Bind any resource',
			);
			console.log('  unlink <id> <link-id>    Remove a binding');
			console.log(
				dim('  For a managed database, hoststack db link <db_…> --service <id> is shorter'),
			);
			console.log();
			console.log('Filters on list:');
			console.log('  --repo <url|owner/name>  Only services building from that repo');
			console.log('  --branch <name>          Only services tracking that branch');
			console.log('  --auto-deploy            Only services that deploy on push');
			console.log('  --no-auto-deploy         Only services that do not');
			console.log();
			console.log('Run `hoststack services update` with no flags for the full field list.');
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
	const repoRef = flagValue(args, '--repo');
	const branchRef = flagValue(args, '--branch');
	// Three states, not two: absent means "don't filter on it".
	const autoDeployFilter = args.includes('--auto-deploy')
		? true
		: args.includes('--no-auto-deploy')
			? false
			: undefined;
	const deployFiltered =
		repoRef !== undefined || branchRef !== undefined || autoDeployFilter !== undefined;

	try {
		const data = await apiFetch<{ services: Service[] }>(`/api/services/${teamId}`);
		let services = data.services;

		if (branchRef !== undefined) {
			services = services.filter((s) => s.branch === branchRef);
		}
		if (autoDeployFilter !== undefined) {
			services = services.filter((s) => Boolean(s.autoDeploy) === autoDeployFilter);
		}
		if (repoRef !== undefined) {
			const want = repoKey(repoRef);
			const keys = await repoKeysForServices(teamId, services);
			services = services.filter((s) => keys.get(s.id) === want);
		}

		if (jsonFlag) {
			console.log(JSON.stringify(services, null, 2));
			return;
		}

		if (services.length === 0) {
			console.log(
				dim(
					deployFiltered
						? 'No services match those filters.'
						: 'No services found. Create one with: hoststack services create',
				),
			);
			return;
		}

		// When the caller asked about deploy wiring, show the columns that
		// answer it — a --auto-deploy listing that hides autoDeploy is a
		// listing you have to verify somewhere else.
		if (deployFiltered) {
			console.log(
				table(
					['ID', 'Name', 'Type', 'Status', 'Branch', 'Auto-deploy'],
					services.map((s) => [
						s.publicId,
						s.name,
						s.type,
						statusBadge(s.status),
						s.branch ?? dim('n/a'),
						s.autoDeploy ? 'yes' : 'no',
					]),
				),
			);
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
					formatDate(s.createdAt),
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
		// The configured image lives on the service's config, not on the row, and for a service
		// deployed by explicit digest it is what actually runs — so it belongs here (task 423).
		// A config this key may not read must not take the whole command down with it.
		const config = await apiFetch<{ config: { dockerImage?: string | null } }>(
			`/api/services/${teamId}/${serviceId}/config`,
		).catch(() => null);

		console.log(`${bold('Name:')}       ${s.name}`);
		console.log(`${bold('ID:')}         ${s.publicId}`);
		console.log(`${bold('Type:')}       ${s.type}`);
		console.log(`${bold('Status:')}     ${statusBadge(s.status)}`);
		if (config?.config.dockerImage) {
			console.log(`${bold('Image:')}      ${config.config.dockerImage}`);
		}
		if (s.internalUrl) {
			console.log(`${bold('Internal:')}   ${s.internalUrl}`);
		}
		console.log(`${bold('Created:')}    ${formatDateTime(s.createdAt)}`);
	} catch (err) {
		handleError(err);
	}
}

// Map short type aliases to the canonical service-type enum. The API
// rejects the short forms, but they were advertised in the v0.x CLI
// help — keep accepting them as aliases. Authoritative enum lives at
// packages/shared/src/types/enums.ts (SERVICE_TYPE).
const SERVICE_TYPE_ALIASES: Record<string, string> = {
	web: 'web_service',
	web_service: 'web_service',
	private: 'private_service',
	private_service: 'private_service',
	worker: 'worker',
	cron: 'cron_job',
	cron_job: 'cron_job',
	static: 'static_site',
	static_site: 'static_site',
};
const SERVICE_TYPE_USAGE = 'web_service | private_service | worker | cron_job | static_site';

async function createService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const nameIdx = args.indexOf('--name');
	const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
	const typeIdx = args.indexOf('--type');
	const typeRaw = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
	const projectIdx = args.indexOf('--project');
	const projectRaw = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
	const runtimeIdx = args.indexOf('--runtime');
	const runtime = runtimeIdx !== -1 ? args[runtimeIdx + 1] : undefined;
	const buildIdx = args.indexOf('--build');
	const buildCommand = buildIdx !== -1 ? args[buildIdx + 1] : undefined;
	const startIdx = args.indexOf('--start');
	const startCommand = startIdx !== -1 ? args[startIdx + 1] : undefined;
	const installIdx = args.indexOf('--install');
	const installCommand = installIdx !== -1 ? args[installIdx + 1] : undefined;
	const repoIdx = args.indexOf('--repo');
	const repoRaw = repoIdx !== -1 ? args[repoIdx + 1] : undefined;
	const branchIdx = args.indexOf('--branch');
	const branch = branchIdx !== -1 ? args[branchIdx + 1] : undefined;
	const publishPathIdx = args.indexOf('--publish-path');
	const publishPath = publishPathIdx !== -1 ? args[publishPathIdx + 1] : undefined;
	const rootIdx = args.indexOf('--root');
	const rootDirectory = rootIdx !== -1 ? args[rootIdx + 1] : undefined;
	const imageIdx = args.indexOf('--image');
	const dockerImage = imageIdx !== -1 ? args[imageIdx + 1] : undefined;
	const templateIdx = args.indexOf('--template');
	const templateId = templateIdx !== -1 ? args[templateIdx + 1] : undefined;
	const portIdx = args.indexOf('--port');
	const portRaw = portIdx !== -1 ? args[portIdx + 1] : undefined;

	if (!name || !typeRaw || !projectRaw) {
		console.log(
			`${bold('Usage:')} hoststack services create --name <name> --type <${SERVICE_TYPE_USAGE}> --project <project-id|prj_…> [--repo <owner/name> [--branch <branch>] [--root <dir>] [--publish-path <dir>]] [--image <ref> [--port <n>]] [--template <id>] [--runtime <runtime>] [--build <cmd>] [--start <cmd>] [--install <cmd>] [--machine <name|id>]`,
		);
		console.log();
		console.log(
			dim(
				'--template creates from a quickstart template: its volumes, scratch dirs, uid, generated secrets and companion managed database are attached server-side before the first deploy. A packaged app also needs the image and port the template ships with, e.g.',
			),
		);
		console.log(
			dim(
				'  hoststack services create --name blog --type web --project prj_… --template wordpress --image wordpress:php8.3-apache --port 80',
			),
		);
		process.exit(1);
	}

	const type = SERVICE_TYPE_ALIASES[typeRaw];
	if (!type) {
		console.error(red(`Invalid --type "${typeRaw}". Expected one of: ${SERVICE_TYPE_USAGE}.`));
		process.exit(1);
	}

	// The port the container listens on, for a prebuilt image whose port is fixed
	// by the image (WordPress 80, Ghost 2368, n8n 5678). Validated here rather
	// than sent as-is: the platform publishes and health-checks this value and
	// never re-reads what the process actually bound, so a typo that survives to
	// the API comes back as a first deploy that times out on a healthy container.
	let port: number | undefined;
	if (portRaw !== undefined) {
		port = Number.parseInt(portRaw, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			console.error(red(`Invalid --port "${portRaw}". Expected an integer 1–65535.`));
			process.exit(1);
		}
	}

	const projectId = await resolveProjectId(teamId, projectRaw);

	// `--repo owner/name` goes to the API as `githubRepo` and is resolved there.
	//
	// It used to be resolved here, against GET /api/github/:teamId/repos — and
	// that never worked: the endpoint answers `{ repos: [...] }`, the call was
	// typed as a bare array, so the lookup died on `repos.find is not a
	// function` for every invocation. Nothing caught it because nothing else in
	// the CLI resolved a repo NAME, and the sibling helper two hundred lines up
	// (`repoKeysForServices`) unwraps the same response correctly. Server-side
	// resolution retires the whole question rather than fixing one copy of it.

	// Own hardware instead of ours. Resolved up front, because placement is
	// pinned at creation and never changed afterwards — a wrong machine is a
	// rebuild, not a setting.
	const machineId = await machineIdFromFlag(args, teamId);

	const s = spinner('Creating service...');

	try {
		const result = await apiFetch<{ service: Service }>(`/api/services/${teamId}`, {
			method: 'POST',
			body: JSON.stringify({
				name,
				type,
				projectId,
				...(repoRaw !== undefined ? { githubRepo: repoRaw } : {}),
				...(branch ? { branch } : {}),
				...(rootDirectory ? { rootDirectory } : {}),
				...(publishPath ? { publishPath } : {}),
				...(runtime ? { runtime } : {}),
				...(buildCommand ? { buildCommand } : {}),
				...(startCommand ? { startCommand } : {}),
				...(installCommand ? { installCommand } : {}),
				...(dockerImage ? { dockerImage } : {}),
				...(port !== undefined ? { port } : {}),
				// An id and nothing else. Everything the template declares —
				// volumes, scratch dirs, `runAsUser`, generated secrets, companion
				// database — is resolved against the catalog server-side, inside
				// the create, because the first deploy fires from the same request:
				// anything applied afterwards misses the only deploy the user is
				// watching.
				...(templateId ? { templateId } : {}),
				...(machineId !== undefined ? { machineId } : {}),
			}),
		});
		s.stop('Service created');
		console.log(
			`${green('+')} ${bold(result.service.name)} ${dim(`(${result.service.publicId})`)}`,
		);
		if (machineId !== undefined) {
			console.log(
				dim('On your own machine — it serves only while that machine is switched on.'),
			);
		}
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
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack services scale <service-id> <min[:max]>`);
		console.log();
		console.log('Examples:');
		console.log('  hoststack services scale svc_abc 2          # fixed at 2 instances');
		console.log('  hoststack services scale svc_abc 2:5        # autoscale between 2 and 5');
		process.exit(1);
	}

	const spec = args[1];
	if (!spec) {
		console.log(`${bold('Usage:')} hoststack services scale <service-id> <min[:max]>`);
		process.exit(1);
	}

	const [minStr, maxStr] = spec.includes(':') ? spec.split(':') : [spec, spec];
	const minInstances = parseInt(minStr ?? '', 10);
	const maxInstances = parseInt(maxStr ?? '', 10);
	if (
		isNaN(minInstances) ||
		isNaN(maxInstances) ||
		minInstances < 0 ||
		maxInstances < 1 ||
		maxInstances < minInstances
	) {
		console.error(
			red(
				'Invalid scale spec. min must be ≥0, max must be ≥1 and ≥min. Example: "2" or "2:5".',
			),
		);
		process.exit(1);
	}

	const label =
		minInstances === maxInstances
			? `${minInstances} instance(s)`
			: `${minInstances}-${maxInstances} instance(s) (autoscale)`;
	const s = spinner(`Scaling to ${label}...`);

	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/config`, {
			method: 'PATCH',
			body: JSON.stringify({ minInstances, maxInstances }),
		});
		s.stop(`Scaled to ${bold(label)}`);
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

// ---------------------------------------------------------------------------
// update — the CLI half of what MCP's update_service_config already does.
//
// Service config used to be reachable only from MCP or the dashboard, which
// made any repeatable setup that has to touch it (turning auto-deploy off
// while onboarding a repo onto dev-ship, say) unscriptable: it needed an agent
// with MCP access or a human clicking. `scale` already proved the CLI is
// willing to mutate a service; this is the rest of that surface.
//
// The fields split across two endpoints — the services row and its
// service_config row — exactly as they do in MCP. Keep the two lists in sync
// with packages/shared/src/schemas/service.ts (updateServiceSchema and
// updateServiceConfigSchema), which is what validates them server-side.
// ---------------------------------------------------------------------------

/** Value of `--flag <value>`, or undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i === -1) return undefined;
	const v = args[i + 1];
	if (v === undefined || v.startsWith('--')) {
		console.error(red(`${flag} needs a value`));
		process.exit(1);
	}
	return v;
}

/** `--flag` / `--no-flag` as a tri-state: undefined means "leave it alone". */
function boolFlag(args: string[], flag: string): boolean | undefined {
	if (args.includes(`--${flag}`)) return true;
	if (args.includes(`--no-${flag}`)) return false;
	return undefined;
}

function intFlag(args: string[], flag: string): number | undefined {
	const raw = flagValue(args, flag);
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || String(n) !== raw.trim()) {
		console.error(red(`${flag} needs a whole number, got "${raw}"`));
		process.exit(1);
	}
	return n;
}

/**
 * A nullable text field. An empty string clears it, mirroring the `null` MCP
 * passes — otherwise there is no way to remove a build command once set.
 */
function textFlag(args: string[], flag: string): string | null | undefined {
	const v = flagValue(args, flag);
	if (v === undefined) return undefined;
	return v === '' ? null : v;
}

function updateUsage(): void {
	console.log(`${bold('Usage:')} hoststack services update <service-id> [flags]`);
	console.log();
	console.log('Build & repo (applies on the next deploy):');
	console.log('  --branch <name>              Git branch to track');
	console.log('  --auto-deploy | --no-auto-deploy   Deploy automatically on push');
	console.log('  --root-directory <path>      Build context root inside the repo');
	console.log('  --install-command <cmd>      Install step ("" clears)');
	console.log('  --build-command <cmd>        Build step ("" clears)');
	console.log('  --start-command <cmd>        Start command ("" clears)');
	console.log('  --dockerfile-path <path>     Dockerfile, relative to root ("" clears)');
	console.log('  --pre-deploy-command <cmd>   Runs before the new release takes traffic');
	console.log();
	console.log('Health checks:');
	console.log('  --health-check | --no-health-check      Toggle health checking');
	console.log('  --health-check-path <path>   HTTP path to GET ("" = TCP-only)');
	console.log('  --health-check-interval <s>  5-300');
	console.log('  --health-check-timeout <s>   1-60');
	console.log('  --health-check-grace <s>     1-1800; raise for slow cold boots');
	console.log();
	console.log('Resources & runtime (applies without a redeploy):');
	console.log('  --memory-mb <n>              128-16384');
	console.log('  --cpu-shares <n>             128-4096');
	console.log('  --disk-size-gb <n>           1-100');
	console.log('  --port <n>                   Container port to forward to');
	console.log('  --protocol <http|tcp>');
	console.log('  --restart-policy <always|on-failure|no>');
	console.log('  --deploy-strategy <rolling|recreate>');
	console.log('  --instances <n>              Pin min and max to N');
	console.log('  --min-instances <n> / --max-instances <n>');
	console.log('  --scale-cpu-threshold <n> / --scale-memory-threshold <n>   10-100');
	console.log('  --search-indexing | --no-search-indexing   Index the *.hoststack.dev URL');
	console.log();
	console.log('Examples:');
	console.log('  hoststack services update svc_abc --no-auto-deploy');
	console.log('  hoststack services update svc_abc --branch main --health-check-grace 180');
}

async function updateService(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId || serviceId === '--help' || serviceId === '-h') {
		updateUsage();
		process.exit(serviceId ? 0 : 1);
	}

	const rest = args.slice(1);

	// services row
	const serviceUpdate: Record<string, unknown> = {};
	const set = (obj: Record<string, unknown>, key: string, value: unknown) => {
		if (value !== undefined) obj[key] = value;
	};
	set(serviceUpdate, 'branch', flagValue(rest, '--branch'));
	set(serviceUpdate, 'autoDeploy', boolFlag(rest, 'auto-deploy'));
	set(serviceUpdate, 'rootDirectory', flagValue(rest, '--root-directory'));
	set(serviceUpdate, 'installCommand', textFlag(rest, '--install-command'));
	set(serviceUpdate, 'buildCommand', textFlag(rest, '--build-command'));
	set(serviceUpdate, 'startCommand', textFlag(rest, '--start-command'));
	set(serviceUpdate, 'dockerfilePath', textFlag(rest, '--dockerfile-path'));
	set(serviceUpdate, 'healthCheckPath', textFlag(rest, '--health-check-path'));

	// service_config row
	const configUpdate: Record<string, unknown> = {};
	set(configUpdate, 'healthCheckEnabled', boolFlag(rest, 'health-check'));
	set(configUpdate, 'allowSearchIndexing', boolFlag(rest, 'search-indexing'));
	set(configUpdate, 'healthCheckInterval', intFlag(rest, '--health-check-interval'));
	set(configUpdate, 'healthCheckTimeout', intFlag(rest, '--health-check-timeout'));
	set(configUpdate, 'healthCheckGracePeriodSec', intFlag(rest, '--health-check-grace'));
	set(configUpdate, 'memoryMb', intFlag(rest, '--memory-mb'));
	set(configUpdate, 'cpuShares', intFlag(rest, '--cpu-shares'));
	set(configUpdate, 'diskSizeGb', intFlag(rest, '--disk-size-gb'));
	set(configUpdate, 'port', intFlag(rest, '--port'));
	set(configUpdate, 'protocol', flagValue(rest, '--protocol'));
	set(configUpdate, 'restartPolicy', flagValue(rest, '--restart-policy'));
	set(configUpdate, 'deployStrategy', flagValue(rest, '--deploy-strategy'));
	set(configUpdate, 'preDeployCommand', flagValue(rest, '--pre-deploy-command'));
	set(configUpdate, 'scaleCpuThreshold', intFlag(rest, '--scale-cpu-threshold'));
	set(configUpdate, 'scaleMemoryThreshold', intFlag(rest, '--scale-memory-threshold'));
	// "Pin to N" is both bounds; explicit bounds win if both are given.
	const instances = intFlag(rest, '--instances');
	if (instances !== undefined) {
		configUpdate['minInstances'] = instances;
		configUpdate['maxInstances'] = instances;
	}
	set(configUpdate, 'minInstances', intFlag(rest, '--min-instances'));
	set(configUpdate, 'maxInstances', intFlag(rest, '--max-instances'));

	const touched = [...Object.keys(serviceUpdate), ...Object.keys(configUpdate)];
	if (touched.length === 0) {
		console.error(red('Nothing to update — pass at least one flag.'));
		console.log();
		updateUsage();
		process.exit(1);
	}

	const s = spinner(`Updating ${serviceId}...`);
	try {
		if (Object.keys(serviceUpdate).length > 0) {
			await apiFetch(`/api/services/${teamId}/${serviceId}`, {
				method: 'PATCH',
				body: JSON.stringify(serviceUpdate),
			});
		}
		if (Object.keys(configUpdate).length > 0) {
			await apiFetch(`/api/services/${teamId}/${serviceId}/config`, {
				method: 'PATCH',
				body: JSON.stringify(configUpdate),
			});
		}
		s.stop(`Updated ${bold(touched.join(', '))}`);
		// Build/repo fields only bite on the next build, so say so rather than
		// letting "Updated" imply the running container changed.
		if (Object.keys(serviceUpdate).length > 0) {
			console.log(dim(`Applies on the next deploy: hoststack deploy trigger ${serviceId}`));
		}
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

// ── Metrics ──────────────────────────────────────────────────────────────

interface MetricsPoint {
	timestamp: string;
	cpuPercent: number;
	memoryUsedMb: number;
	memoryLimitMb: number;
	networkRxBytes: number;
	networkTxBytes: number;
	diskUsedMb: number;
}

/**
 * `serverOverview` is the newest host-level sample the platform holds — the
 * most recent `server_metrics` row with no `serviceId`. It is NOT filtered to
 * the worker this service sits on: the query has no host predicate, so on a
 * multi-host fleet it is whichever host reported last. Labelled accordingly
 * below; calling it "the host this service runs on" would be a number with a
 * wrong name attached, which is worse than no number.
 */
interface MetricsSnapshot {
	metrics: MetricsPoint | null;
	serverOverview: {
		cpuPercent: number;
		memoryUsedMb: number;
		memoryLimitMb: number;
		diskUsedMb: number;
	} | null;
}

function mib(mb: number): string {
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function bytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

function pct(used: number, limit: number): string {
	if (limit <= 0) return '';
	const share = Math.round((used / limit) * 100);
	const text = `${share}%`;
	// There is no swap in a container: crossing the memory limit is a SIGKILL
	// with no slow-down phase, so 95% is not "nearly full", it is the state
	// that ends in an OOM. Colour it like one.
	if (share >= 90) return red(text);
	if (share >= 75) return yellow(text);
	return dim(text);
}

/**
 * What the container is actually using, from the terminal.
 *
 * CPU, memory against its limit, disk and network — the same readings the
 * dashboard's metrics tab draws, which were MCP-and-dashboard only. The
 * memory percentage is the one worth looking at: there is no swap in a
 * container, so crossing the limit is an immediate SIGKILL with no slow-down
 * phase, and 95% is not "nearly full" — it is the state that ends in an OOM.
 */
async function serviceMetrics(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId || serviceId.startsWith('--')) {
		console.log(
			`${bold('Usage:')} hoststack services metrics <service-id> [--history] [--from <t>] [--to <t>] [--json]`,
		);
		console.log();
		console.log(dim('  --history   a time series instead of the latest sample'));
		console.log(dim('  --from/--to ISO-8601. Omit both for the trailing hour.'));
		console.log(
			dim('  Resolution is the server’s: raw samples ≤7d, hourly ≤30d, daily beyond.'),
		);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');
	const wantHistory = args.includes('--history');

	try {
		if (wantHistory) {
			const params = new URLSearchParams();
			const from = flagValue(args, '--from');
			const to = flagValue(args, '--to');
			if (from) params.set('from', from);
			if (to) params.set('to', to);
			const qs = params.toString();
			const { history } = await apiFetch<{ history: MetricsPoint[] }>(
				`/api/services/${teamId}/${serviceId}/metrics/history${qs ? `?${qs}` : ''}`,
			);

			if (jsonFlag) {
				console.log(JSON.stringify(history, null, 2));
				return;
			}
			if (history.length === 0) {
				console.log(dim('No samples in that window.'));
				return;
			}
			console.log(
				table(
					['When', 'CPU', 'Memory', 'Disk', 'Net in', 'Net out'],
					history.map((p) => [
						formatDateTime(p.timestamp),
						`${p.cpuPercent.toFixed(1)}%`,
						`${mib(p.memoryUsedMb)} ${pct(p.memoryUsedMb, p.memoryLimitMb)}`,
						mib(p.diskUsedMb),
						bytes(p.networkRxBytes),
						bytes(p.networkTxBytes),
					]),
				),
			);
			// Aggregated buckets hide the peak that actually killed something.
			// Say which resolution this is rather than letting a flat daily
			// line read as a quiet week.
			console.log();
			console.log(
				dim(
					`${history.length} points. Longer windows are pre-aggregated — a spike inside a bucket is averaged away.`,
				),
			);
			return;
		}

		const snapshot = await apiFetch<MetricsSnapshot>(
			`/api/services/${teamId}/${serviceId}/metrics`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(snapshot, null, 2));
			return;
		}

		const m = snapshot.metrics;
		if (!m) {
			// Null is not zero. A suspended service, one between deploys, and
			// one whose agent has never reported all land here, and printing
			// "0% CPU" for any of them is a lie with a number on it.
			console.log(dim('No sample yet — the agent has not reported for this service.'));
			console.log(
				dim('A suspended service, or one between deploys, reports nothing by design.'),
			);
		} else {
			console.log(bold('Container'));
			console.log(`  CPU      ${m.cpuPercent.toFixed(1)}%`);
			console.log(
				`  Memory   ${mib(m.memoryUsedMb)} of ${mib(m.memoryLimitMb)} ${pct(m.memoryUsedMb, m.memoryLimitMb)}`,
			);
			console.log(`  Disk     ${mib(m.diskUsedMb)}`);
			console.log(
				`  Network  ${bytes(m.networkRxBytes)} in / ${bytes(m.networkTxBytes)} out`,
			);
			console.log(`  ${dim(`sampled ${formatDateTime(m.timestamp)}`)}`);
		}

		const host = snapshot.serverOverview;
		if (host) {
			console.log();
			console.log(bold('Latest host sample'));
			console.log(`  CPU      ${host.cpuPercent.toFixed(1)}%`);
			console.log(
				`  Memory   ${mib(host.memoryUsedMb)} of ${mib(host.memoryLimitMb)} ${pct(host.memoryUsedMb, host.memoryLimitMb)}`,
			);
			console.log(`  Disk     ${mib(host.diskUsedMb)}`);
			console.log(
				dim('  The newest host-level reading the platform holds — not necessarily the'),
			);
			console.log(dim('  worker this service is placed on. Do not read it as one.'));
		}
	} catch (err) {
		handleError(err);
	}
}

// ── Templates ────────────────────────────────────────────────────────────

/**
 * The quickstart catalog `services create --template` takes an id from.
 *
 * `--template` has existed for a while with no way to see what may be passed
 * to it, which made it a flag you could only use if you already knew the
 * answer. An image template also needs the image and port printed here passed
 * alongside: the API takes those two off the wire even for a template, so
 * `--template wordpress` on its own creates a service with no image.
 */
function listTemplates(args: string[]): void {
	if (args.includes('--json')) {
		console.log(JSON.stringify(APP_TEMPLATES, null, 2));
		return;
	}

	const sourceBuilt = APP_TEMPLATES.filter((t) => !t.dockerImage);
	const images = APP_TEMPLATES.filter((t) => t.dockerImage);

	console.log(bold('Built from your repo'));
	console.log(
		table(
			['ID', 'Name', 'Type'],
			sourceBuilt.map((t) => [t.id, t.name, t.type]),
		),
	);

	if (images.length > 0) {
		console.log();
		console.log(bold('Packaged apps (prebuilt images)'));
		console.log(
			table(
				['ID', 'Name', 'Image', 'Port'],
				images.map((t) => [t.id, t.name, t.dockerImage ?? '', String(t.port ?? '')]),
			),
		);
		console.log();
		console.log(
			dim('  These need their image and port passed too — the template id alone does not'),
		);
		console.log(
			dim('  carry them. Everything else they bring (volume, scratch dirs, uid, generated'),
		);
		console.log(
			dim('  secrets, companion database) is attached server-side before first deploy.'),
		);
	}

	console.log();
	console.log(`${bold('Examples:')}`);
	console.log(dim('  hoststack services create --name api --type web --project prj_abc \\'));
	console.log(dim('      --repo owner/name --template bun-hono'));
	console.log(dim('  hoststack services create --name blog --type web --project prj_abc \\'));
	console.log(dim('      --template wordpress --image wordpress:php8.3-apache --port 80'));
}

// ── Resource links ───────────────────────────────────────────────────────

interface ResourceLink {
	id: number;
	serviceId: number;
	resourceType: string;
	resourceId: number;
	alias: string;
}

const RESOURCE_TYPES = ['database', 'object_storage', 'queue', 'search', 'email_domain'];

/**
 * Bind any managed resource to a service, not just a database.
 *
 * `hoststack db link` has always spoken to this same generic route, but with
 * `resourceType: 'database'` hard-coded — so object storage, a queue, a search
 * index or an email domain could be linked from the dashboard and the MCP and
 * nowhere else. `db link` stays: it resolves a `db_…` publicId and derives the
 * alias, which is the ninety-percent case and worth the shortcut.
 */
async function linkResource(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0]?.startsWith('--') ? undefined : args[0];
	const type = flagValue(args, '--type');
	const resourceId = flagValue(args, '--resource');
	const alias = flagValue(args, '--alias');

	if (!serviceId || !type || !resourceId || !alias) {
		console.log(
			`${bold('Usage:')} hoststack services link <service-id> --type <${RESOURCE_TYPES.join('|')}> --resource <numeric-id> --alias <PREFIX>`,
		);
		console.log();
		console.log(dim('  --resource is the NUMERIC id of the resource, not a publicId.'));
		console.log(dim('  --alias is the uppercase env-var prefix its connection info is'));
		console.log(dim('  injected under: APP_DB -> APP_DB_HOST, APP_DB_URL, …'));
		console.log();
		console.log(dim('  For a managed database: hoststack db link <db_…> --service <svc-id>'));
		console.log(dim('  resolves the publicId and picks the alias for you.'));
		process.exit(1);
	}
	if (!RESOURCE_TYPES.includes(type)) {
		console.error(
			red(`Unknown resource type "${type}". One of: ${RESOURCE_TYPES.join(', ')}.`),
		);
		process.exit(1);
	}
	if (!/^\d+$/.test(resourceId)) {
		console.error(red(`--resource must be a numeric id, got "${resourceId}".`));
		process.exit(1);
	}
	if (!/^[A-Z][A-Z0-9_]*$/.test(alias)) {
		console.error(red(`--alias must be uppercase letters, digits and underscores, starting`));
		console.error(red(`with a letter. Got "${alias}".`));
		process.exit(1);
	}

	const s = spinner('Linking...');
	try {
		const { link } = await apiFetch<{ link: ResourceLink }>(
			`/api/services/${teamId}/${serviceId}/resources`,
			{
				method: 'POST',
				body: JSON.stringify({
					resourceType: type,
					resourceId: Number(resourceId),
					alias,
				}),
			},
		);
		s.stop('Linked');
		console.log(
			`${green('+')} ${type} ${link.resourceId} ${dim('->')} ${bold(serviceId)} ${dim(`(alias ${link.alias})`)}`,
		);
		console.log();
		console.log(dim('Takes effect on the next deploy:'));
		console.log(`  hoststack deploy trigger ${serviceId}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function listResourceLinks(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0];
	if (!serviceId || serviceId.startsWith('--')) {
		console.log(`${bold('Usage:')} hoststack services links <service-id> [--json]`);
		process.exit(1);
	}

	try {
		const { links } = await apiFetch<{ links: ResourceLink[] }>(
			`/api/services/${teamId}/${serviceId}/resources`,
		);
		if (args.includes('--json')) {
			console.log(JSON.stringify(links, null, 2));
			return;
		}
		if (links.length === 0) {
			console.log(dim('No resources linked — nothing is being injected into this service.'));
			return;
		}
		console.log(
			table(
				['Link', 'Type', 'Resource', 'Alias'],
				links.map((l) => [String(l.id), l.resourceType, String(l.resourceId), l.alias]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function unlinkResource(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const serviceId = args[0]?.startsWith('--') ? undefined : args[0];
	const linkId = args[1] && !args[1].startsWith('--') ? args[1] : flagValue(args, '--link');
	if (!serviceId || !linkId) {
		console.log(`${bold('Usage:')} hoststack services unlink <service-id> <link-id>`);
		console.log();
		console.log(dim('Find the link id with: hoststack services links <service-id>'));
		console.log(dim('Removes the binding only — the resource itself is untouched.'));
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
