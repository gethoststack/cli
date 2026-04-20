import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, table } from '../lib/output.ts';

interface Project {
	id: number;
	publicId: string;
	name: string;
	slug: string;
	description?: string | null;
	region: string;
	createdAt: string;
}

export async function projectsCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listProjects(args.slice(1));
		case 'create':
			return createProject(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteProject(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack projects <command>`);
			console.log();
			console.log('Commands:');
			console.log('  list         List all projects');
			console.log('  create       Create a new project');
			console.log('  delete       Delete a project');
			process.exit(1);
	}
}

async function listProjects(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const data = await apiFetch<{ projects: Project[] }>(`/api/projects/${teamId}`);
		const projects = data.projects;

		if (jsonFlag) {
			console.log(JSON.stringify(projects, null, 2));
			return;
		}

		if (projects.length === 0) {
			console.log(dim('No projects found. Create one with: hoststack projects create'));
			return;
		}

		console.log(
			table(
				['ID', 'Name', 'Region', 'Created'],
				projects.map((p) => [
					p.publicId,
					p.name,
					p.region,
					new Date(p.createdAt).toLocaleDateString(),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function createProject(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const nameIdx = args.indexOf('--name');
	const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

	if (!name) {
		console.log(
			`${bold('Usage:')} hoststack projects create --name <name> [--description <desc>] [--region <region>]`,
		);
		process.exit(1);
	}

	const descIdx = args.indexOf('--description');
	const description = descIdx !== -1 ? args[descIdx + 1] : undefined;
	const regionIdx = args.indexOf('--region');
	const region = regionIdx !== -1 ? args[regionIdx + 1] : undefined;

	const s = spinner('Creating project...');

	try {
		const project = await apiFetch<{ project: Project }>(`/api/projects/${teamId}`, {
			method: 'POST',
			body: JSON.stringify({ name, description, region }),
		});
		s.stop('Project created');
		console.log(
			`${green('+')} ${bold(project.project.name)} ${dim(`(${project.project.publicId})`)}`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteProject(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const projectId = args[0];
	if (!projectId) {
		console.log(`${bold('Usage:')} hoststack projects delete <project-id>`);
		process.exit(1);
	}

	const s = spinner('Deleting project...');

	try {
		await apiFetch(`/api/projects/${teamId}/${projectId}`, { method: 'DELETE' });
		s.stop('Project deleted');
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
