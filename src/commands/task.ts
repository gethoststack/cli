import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, cyan, dim, green, handleError, red, statusBadge, table } from '../lib/output.ts';

/**
 * The per-project agent task backlog behind a dev box.
 *
 * Until this command existed the only way in from a terminal was
 * `hoststack errors fix <issue-id>`, which authors a task FROM an exception.
 * Work that did not start as a crash — a coverage gap, a follow-up another
 * service is waiting on — had no route at all, and the honest workaround was a
 * hand-rolled `curl` against `/api/dev-env-tasks/:teamId`.
 *
 * A task is a written prompt, not a running agent: `add` files it as an idea,
 * and starting it stays a separate, deliberate step. That is what makes it
 * useful to queue work for a box that is asleep.
 */
interface Task {
	id: number;
	publicId: string;
	projectId: number;
	serviceId: number | null;
	title: string;
	body: string;
	status: string;
	createdAt: string;
}

export async function taskCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listTasks(args.slice(1));
		case 'add':
		case 'create':
			return addTask(args.slice(1));
		case 'show':
		case 'get':
			return showTask(args.slice(1));
		case 'done':
			return setStatus(args.slice(1), 'done');
		case 'reopen':
			return setStatus(args.slice(1), 'idea');
		case 'delete':
		case 'rm':
			return deleteTask(args.slice(1));
		default:
			usage();
			process.exit(1);
	}
}

function usage(): void {
	console.log(`${bold('Usage:')} hoststack task <command>`);
	console.log();
	console.log('Commands:');
	console.log("  list --project <id>                 The project's task backlog");
	console.log('  add --project <id> <title>          File a task (idea)');
	console.log('  show <task-id>                      One task, with its full prompt');
	console.log('  done <task-id>                      Mark it finished');
	console.log('  reopen <task-id>                    Put it back in the backlog');
	console.log('  delete <task-id>                    Delete it outright');
	console.log();
	console.log('Options for add:');
	console.log('  --box <service-id>                  Pin it to a dev box');
	console.log(
		'  --body <text>                       The prompt. Use --body-file for anything long',
	);
	console.log(
		'  --body-file <path>                  Read the prompt from a file, or - for stdin',
	);
	console.log();
	console.log(dim('Task ids accept the task_… public id or the numeric id.'));
	console.log();
	console.log(`${bold('Examples:')}`);
	console.log(dim('  hoststack task list --project prj_abc'));
	console.log(
		dim('  hoststack task add --project prj_abc --box svc_xyz "Fix the footprint join"'),
	);
	console.log(
		dim('  cat brief.md | hoststack task add --project prj_abc --body-file - "Big one"'),
	);
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

/** Everything that is not a flag or a flag's value - i.e. the positional words. */
function positionals(args: string[], flagsWithValues: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith('--')) {
			if (flagsWithValues.includes(a)) i++;
			continue;
		}
		out.push(a);
	}
	return out;
}

/**
 * Resolve a `task_…` public id to the numeric id the write routes want.
 *
 * The API is asymmetric here: create ANSWERS with a publicId, and PATCH/DELETE
 * reject that same string with `400 Invalid task ID`. Knowing two ids for one
 * task is not something a person should have to carry, so the CLI does the
 * lookup. A numeric id passes straight through.
 */
async function resolveTaskId(teamId: number, given: string): Promise<number> {
	if (/^\d+$/.test(given)) return Number.parseInt(given, 10);
	if (!given.startsWith('task_')) {
		console.error(red(`Invalid task id "${given}": expected task_… or numeric.`));
		process.exit(1);
	}
	const { projects } = await apiFetch<{ projects: Array<{ id: number }> }>(
		`/api/projects/${teamId}`,
	);
	for (const p of projects ?? []) {
		const { tasks } = await apiFetch<{ tasks: Task[] }>(
			`/api/dev-env-tasks/${teamId}?projectId=${p.id}`,
		);
		const hit = (tasks ?? []).find((t) => t.publicId === given);
		if (hit) return hit.id;
	}
	console.error(red(`No task ${given} in this team.`));
	process.exit(1);
}

async function requireProjectId(teamId: number, given: string | undefined): Promise<number> {
	if (!given) {
		console.error(red('--project is required.'));
		process.exit(1);
	}
	if (/^\d+$/.test(given)) return Number.parseInt(given, 10);
	const { projects } = await apiFetch<{ projects: Array<{ id: number; publicId: string }> }>(
		`/api/projects/${teamId}`,
	);
	const hit = (projects ?? []).find((p) => p.publicId === given);
	if (!hit) {
		console.error(red(`No project ${given} in this team.`));
		process.exit(1);
	}
	return hit.id;
}

async function listTasks(args: string[]): Promise<void> {
	const teamId = requireTeam();
	try {
		const projectId = await requireProjectId(teamId, flag(args, '--project'));
		const { tasks, automodeEnabled } = await apiFetch<{
			tasks: Task[];
			automodeEnabled: boolean;
		}>(`/api/dev-env-tasks/${teamId}?projectId=${projectId}`);

		if (!tasks || tasks.length === 0) {
			console.log(dim('No tasks in this project.'));
			return;
		}
		console.log(
			table(
				['ID', 'STATUS', 'BOX', 'TITLE'],
				tasks.map((t) => [
					t.publicId,
					statusBadge(t.status),
					t.serviceId === null ? dim('-') : String(t.serviceId),
					t.title.length > 60 ? `${t.title.slice(0, 59)}…` : t.title,
				]),
			),
		);
		// A queued task sits still forever on an install that will not start one,
		// and nothing else on this surface says so.
		if (!automodeEnabled && tasks.some((t) => t.status === 'queued')) {
			console.log();
			console.log(dim('Automode is off here: queued tasks wait for someone to start them.'));
		}
	} catch (err) {
		handleError(err);
	}
}

async function addTask(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const title = positionals(args, ['--project', '--box', '--body', '--body-file'])
		.join(' ')
		.trim();
	if (!title) {
		console.log(`${bold('Usage:')} hoststack task add --project <id> [--box <id>] <title>`);
		process.exit(1);
	}

	let body = flag(args, '--body') ?? '';
	const bodyFile = flag(args, '--body-file');
	if (bodyFile) {
		// `-` means stdin, so a long brief can be piped instead of shell-quoted.
		body =
			bodyFile === '-'
				? await new Response(Bun.stdin.stream()).text()
				: await Bun.file(bodyFile).text();
	}

	try {
		const projectId = await requireProjectId(teamId, flag(args, '--project'));
		const box = flag(args, '--box');
		const serviceId = box
			? /^\d+$/.test(box)
				? Number.parseInt(box, 10)
				: await resolveServiceId(teamId, box)
			: undefined;

		const { task } = await apiFetch<{ task: Task }>(`/api/dev-env-tasks/${teamId}`, {
			method: 'POST',
			body: JSON.stringify({
				projectId,
				title,
				...(body ? { body } : {}),
				...(serviceId ? { serviceId } : {}),
			}),
		});

		console.log(green(`Filed ${task.publicId}: ${task.title}`));
		console.log(
			dim(
				serviceId
					? 'Written, not started. Open the box to read the prompt and run it.'
					: 'A loose idea - pin it to a box with --box when you want it run.',
			),
		);
	} catch (err) {
		handleError(err);
	}
}

/**
 * A `--box` is a DEV ENVIRONMENT, and `/api/services/:teamId` filters those out
 * - so looking a box up in the service list finds nothing, which is exactly how
 * the first real run of this command failed. Ask the services list first (a
 * task can be pinned to an ordinary service too), then the dev-env list.
 */
async function resolveServiceId(teamId: number, publicId: string): Promise<number> {
	const { services } = await apiFetch<{ services: Array<{ id: number; publicId: string }> }>(
		`/api/services/${teamId}`,
	);
	const hit = (services ?? []).find((s) => s.publicId === publicId);
	if (hit) return hit.id;

	const { environments } = await apiFetch<{
		environments: Array<{ id: number; publicId: string }>;
	}>(`/api/dev-environments/${teamId}`);
	const box = (environments ?? []).find((e) => e.publicId === publicId);
	if (box) return box.id;

	console.error(red(`No service or dev box ${publicId} in this team.`));
	process.exit(1);
}

async function showTask(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const given = args[0];
	if (!given) {
		console.log(`${bold('Usage:')} hoststack task show <task-id>`);
		process.exit(1);
	}
	try {
		const id = await resolveTaskId(teamId, given);
		const { task } = await apiFetch<{ task: Task }>(`/api/dev-env-tasks/${teamId}/${id}`);
		console.log(bold(task.title));
		console.log(
			`${cyan(task.publicId)}  ${statusBadge(task.status)}  ${dim(
				task.serviceId === null ? 'no box' : `box ${task.serviceId}`,
			)}`,
		);
		if (task.body) {
			console.log();
			console.log(task.body);
		}
	} catch (err) {
		handleError(err);
	}
}

async function setStatus(args: string[], status: 'done' | 'idea'): Promise<void> {
	const teamId = requireTeam();
	const given = args[0];
	if (!given) {
		console.log(
			`${bold('Usage:')} hoststack task ${status === 'done' ? 'done' : 'reopen'} <task-id>`,
		);
		process.exit(1);
	}
	try {
		const id = await resolveTaskId(teamId, given);
		const { task } = await apiFetch<{ task: Task }>(`/api/dev-env-tasks/${teamId}/${id}`, {
			method: 'PATCH',
			body: JSON.stringify({ status }),
		});
		console.log(green(`${task.publicId} is now ${task.status}: ${task.title}`));
	} catch (err) {
		handleError(err);
	}
}

async function deleteTask(args: string[]): Promise<void> {
	const teamId = requireTeam();
	const given = args[0];
	if (!given) {
		console.log(`${bold('Usage:')} hoststack task delete <task-id>`);
		process.exit(1);
	}
	try {
		const id = await resolveTaskId(teamId, given);
		await apiFetch(`/api/dev-env-tasks/${teamId}/${id}`, { method: 'DELETE' });
		console.log(green(`Deleted ${given}.`));
		console.log(dim('`task done` keeps the row and its provenance; delete throws both away.'));
	} catch (err) {
		handleError(err);
	}
}
