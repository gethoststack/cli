import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, statusBadge, table } from '../lib/output.ts';
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

	// Resolve --repo (owner/name) to the numeric github_repos row id the API
	// expects as `githubRepoId`. If the app can't see the repo yet, hint at the
	// sync command rather than failing with a bare "not found".
	let githubRepoId: number | undefined;
	if (repoRaw !== undefined) {
		githubRepoId = await resolveGithubRepoId(teamId, repoRaw);
	}

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
				...(githubRepoId !== undefined ? { githubRepoId } : {}),
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

interface GithubRepo {
	id: number;
	fullName: string;
	accountLogin: string;
}

/**
 * Resolve a `owner/name` string to the numeric github_repos row id that the
 * create-service endpoint expects as `githubRepoId`. Matches case-insensitively
 * against the repos the connected GitHub App(s) can see. Exits with a helpful
 * message (pointing at `hoststack github sync`) when nothing matches — the most
 * common cause is a brand-new repo the installation hasn't re-synced yet.
 */
async function resolveGithubRepoId(teamId: number, repo: string): Promise<number> {
	const wanted = repo.trim().toLowerCase();
	let repos: GithubRepo[];
	try {
		repos = await apiFetch<GithubRepo[]>(`/api/github/${teamId}/repos`);
	} catch (err) {
		handleError(err);
		process.exit(1);
	}
	const match = repos.find((r) => r.fullName.toLowerCase() === wanted);
	if (!match) {
		console.error(red(`Repository "${repo}" not found among connected GitHub repos.`));
		console.error(
			dim(
				'If you just pushed it, run `hoststack github sync` to refresh the list, or check the owner/name spelling.',
			),
		);
		process.exit(1);
	}
	return match.id;
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
