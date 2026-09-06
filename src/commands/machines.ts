import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, cyan, dim, handleError, red, spinner, table, yellow } from '../lib/output.ts';

/**
 * A machine the team owns and enrolled as a runner. Mirrors
 * `GET /api/machines/:teamId`. The CLI is a standalone published package with
 * no @hoststack/shared dependency, so the shape is restated here.
 */
interface Machine {
	id: number;
	hostname: string;
	name: string;
	status: string;
	enrolled: boolean;
	totalMemoryMb: number | null;
	totalCpuCores: number | null;
	lastHeartbeatAt: string | null;
	createdAt: string;
	agentBuild: 'current' | 'behind' | 'from-source' | 'unknown';
	agentVersion: string | null;
	targetAgentVersion: string | null;
	agentUpdateStuck: boolean;
	workloads: { devBoxes: number; services: number; databases: number };
}

interface MachineWorkload {
	kind: 'dev_box' | 'service' | 'database';
	id: number;
	publicId: string;
	name: string;
	status: string;
	engine?: string;
}

interface Pairing {
	pairingToken: string;
	expiresAt: string;
	installCommand: string;
	installCommandPowerShell: string;
}

export async function machinesCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listMachines(args.slice(1));
		case 'show':
		case 'get':
			return showMachine(args.slice(1));
		case 'add':
		case 'create':
		case 'enrol':
		case 'enroll':
			return addMachine(args.slice(1));
		case 'remove':
		case 'rm':
		case 'delete':
			return removeMachine(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack machines <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list                       List your enrolled machines');
			console.log('  show <machine>             What is running on one machine');
			console.log('  add <name>                 Register a machine, print its installer');
			console.log('  remove <machine>           Unenrol a machine, print how to clean it up');
			console.log();
			console.log(
				dim(
					'Your own hardware — a spare desktop, a home server, a VPS you already pay for.',
				),
			);
			console.log(
				dim(
					'Pin work to one with --machine on `services create`, `db create` or `dev create`.',
				),
			);
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

/**
 * The one sentence that matters about a machine, matching the dashboard's
 * vocabulary rather than the raw `status` column.
 *
 * `from-source` is deliberately not green: we never replace an agent someone
 * built from their own tree, so its contents are unknowable rather than
 * current — reporting it as up to date is how a machine ran for months without
 * a shipped fix.
 */
function machineState(m: Machine): string {
	if (!m.enrolled) return yellow('not paired');
	if (m.status !== 'active') {
		const serving = m.workloads.services > 0 || m.workloads.databases > 0;
		return serving ? yellow('offline') : dim('offline');
	}
	if (m.agentBuild === 'from-source') return yellow('from source');
	if (m.agentBuild === 'unknown') return yellow('agent too old');
	if (m.agentBuild === 'behind') return m.agentUpdateStuck ? yellow('update failed') : 'updating';
	return 'online';
}

function describeWorkloads(w: Machine['workloads']): string {
	const parts: string[] = [];
	if (w.devBoxes > 0) parts.push(`${w.devBoxes} dev box${w.devBoxes === 1 ? '' : 'es'}`);
	if (w.services > 0) parts.push(`${w.services} service${w.services === 1 ? '' : 's'}`);
	if (w.databases > 0) parts.push(`${w.databases} database${w.databases === 1 ? '' : 's'}`);
	return parts.length === 0 ? dim('—') : parts.join(', ');
}

async function listMachines(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const jsonFlag = args.includes('--json');

	try {
		const { machines } = await apiFetch<{ machines: Machine[] }>(`/api/machines/${teamId}`);

		if (jsonFlag) {
			console.log(JSON.stringify(machines, null, 2));
			return;
		}

		if (machines.length === 0) {
			console.log(dim('No machines enrolled. Everything runs on HostStack compute.'));
			console.log(
				dim(`Enrol your own hardware with: ${cyan('hoststack machines add <name>')}`),
			);
			return;
		}

		console.log(
			table(
				['ID', 'Name', 'State', 'Running', 'Memory', 'CPU'],
				machines.map((m) => [
					String(m.id),
					m.name,
					machineState(m),
					describeWorkloads(m.workloads),
					m.totalMemoryMb === null
						? dim('—')
						: `${Math.round(m.totalMemoryMb / 1024)} GB`,
					m.totalCpuCores === null ? dim('—') : String(m.totalCpuCores),
				]),
			),
		);
		console.log();
		console.log(
			dim(
				'Pin work to one with --machine <name> on `services create`, `db create` or `dev create`.',
			),
		);
	} catch (err) {
		handleError(err);
	}
}

/**
 * Resolve what the user typed — a name or a numeric id — to a machine.
 *
 * Refuses an ambiguous name rather than picking one: two machines called
 * "desktop" are two different physical computers, and work pinned to one cannot
 * be moved to the other afterwards.
 */
async function resolveMachine(teamId: number, needle: string): Promise<Machine> {
	const { machines } = await apiFetch<{ machines: Machine[] }>(`/api/machines/${teamId}`);
	if (machines.length === 0) {
		console.error(red('No machines enrolled.'));
		console.error(dim(`Enrol one with: hoststack machines add <name>`));
		process.exit(1);
	}

	const asId = Number.parseInt(needle, 10);
	const byId = Number.isNaN(asId) ? undefined : machines.find((m) => m.id === asId);
	if (byId) return byId;

	const lower = needle.toLowerCase();
	const matches = machines.filter(
		(m) => m.name.toLowerCase() === lower || m.hostname.toLowerCase() === lower,
	);
	if (matches.length === 1) return matches[0]!;

	if (matches.length > 1) {
		console.error(red(`More than one machine is named "${needle}". Use its numeric id:`));
		for (const m of matches) console.error(dim(`  ${m.id}  ${m.name}`));
		process.exit(1);
	}
	console.error(red(`No machine named "${needle}". You have:`));
	for (const m of machines) console.error(dim(`  ${m.id}  ${m.name}`));
	process.exit(1);
}

async function showMachine(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const target = args[0];
	if (!target) {
		console.log(`${bold('Usage:')} hoststack machines show <machine> [--json]`);
		process.exit(1);
	}
	const jsonFlag = args.includes('--json');

	try {
		const machine = await resolveMachine(teamId, target);
		const detail = await apiFetch<{ machine: Machine; running: MachineWorkload[] }>(
			`/api/machines/${teamId}/${machine.id}`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(detail, null, 2));
			return;
		}

		const m = detail.machine;
		console.log(`${bold(m.name)}  ${machineState(m)}  ${dim(`id ${m.id}`)}`);
		console.log(
			dim(
				`agent ${m.agentVersion ?? 'unreported'}${
					m.targetAgentVersion && m.agentVersion !== m.targetAgentVersion
						? ` (we ship ${m.targetAgentVersion})`
						: ''
				}${m.lastHeartbeatAt ? ` · last heard from ${new Date(m.lastHeartbeatAt).toLocaleString()}` : ''}`,
			),
		);
		console.log();

		if (detail.running.length === 0) {
			console.log(dim('Nothing is running on it.'));
			return;
		}
		console.log(
			table(
				['Kind', 'Name', 'ID', 'Status'],
				detail.running.map((w) => [
					w.kind === 'dev_box' ? 'dev box' : w.kind,
					w.name,
					w.publicId,
					w.status,
				]),
			),
		);
		console.log();
		// The trade this feature asks the customer to make, stated where it is
		// about to matter: they are usually reading this before turning it off.
		console.log(
			dim(
				'Switch this machine off and everything above is unavailable until it comes back. Files and database data stay on its disk.',
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function addMachine(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const name = args.find((a) => !a.startsWith('--'));
	if (!name) {
		console.log(`${bold('Usage:')} hoststack machines add <name>`);
		console.log(dim('  e.g. hoststack machines add desktop'));
		process.exit(1);
	}

	const s = spinner(`Registering machine "${name}"...`);
	try {
		const pairing = await apiFetch<Pairing>(`/api/machines/${teamId}`, {
			method: 'POST',
			body: JSON.stringify({ name }),
		});
		s.stop(`Registered "${name}"`);
		console.log();
		console.log(`Run this ${bold('on the machine itself')} (Linux/macOS, as root):`);
		console.log();
		console.log(`  ${cyan(pairing.installCommand)}`);
		console.log();
		console.log(dim('Windows PowerShell (as Administrator):'));
		console.log();
		console.log(`  ${dim(pairing.installCommandPowerShell)}`);
		console.log();
		// The token is single-use and short-lived, and it is the one credential
		// in this flow. Saying when it dies is the difference between "run this
		// later" and coming back to a command that silently fails.
		console.log(
			dim(
				`The command carries a single-use pairing token that expires ${new Date(pairing.expiresAt).toLocaleString()}. Generate a fresh one from the dashboard if it does.`,
			),
		);
		console.log(
			dim(
				`It installs Docker if the machine has none, then starts the agent. Check it arrived with: ${cyan('hoststack machines list')}`,
			),
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/**
 * Unenrol a machine.
 *
 * The API refuses while anything is still pinned to it, and names what — the
 * files and database data are on that machine's disk, so a removal that
 * succeeded would leave rows pointing at a host nothing can reach again. That
 * refusal is the guard, which is why this does not ask for confirmation of its
 * own: the destructive case cannot get this far.
 *
 * Removal is a control-plane act and does not touch the machine. The agent is
 * still installed and will keep trying to connect with a secret we no longer
 * recognise, so the cleanup command is printed rather than left to be found in
 * the docs.
 */
async function removeMachine(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const target = args[0];
	if (!target) {
		console.log(`${bold('Usage:')} hoststack machines remove <machine>`);
		process.exit(1);
	}

	try {
		const machine = await resolveMachine(teamId, target);
		const s = spinner(`Removing "${machine.name}"...`);
		try {
			await apiFetch(`/api/machines/${teamId}/${machine.id}`, { method: 'DELETE' });
		} catch (err) {
			s.stop(red('Failed'));
			throw err;
		}
		s.stop(`Removed "${machine.name}"`);
		console.log();
		console.log(dim('HostStack will not talk to it again. To clean up the machine itself:'));
		console.log();
		console.log(
			`  ${cyan('docker rm -f hoststack-agent && sudo rm -rf /var/lib/hoststack-agent')}`,
		);
	} catch (err) {
		handleError(err);
	}
}

/**
 * Shared `--machine <name|id>` flag for the create commands.
 *
 * Returns the numeric id the API pins on, or undefined when the flag is absent
 * — which is the default, and means HostStack compute.
 */
export async function machineIdFromFlag(
	args: string[],
	teamId: number,
): Promise<number | undefined> {
	const idx = args.indexOf('--machine');
	if (idx < 0) return undefined;
	const value = args[idx + 1];
	if (!value || value.startsWith('--')) {
		console.error(red('--machine needs a machine name or id (see: hoststack machines list)'));
		process.exit(1);
	}
	const machine = await resolveMachine(teamId, value);
	return machine.id;
}
