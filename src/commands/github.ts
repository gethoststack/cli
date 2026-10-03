import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner, table } from '../lib/output.ts';

interface Installation {
	id: number;
	accountLogin: string;
}

interface SyncedRepo {
	id: number;
	fullName: string;
}

interface ConnectedRepo {
	id: number;
	fullName: string;
	defaultBranch: string;
	isPrivate: boolean;
}

export async function githubCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'help';

	switch (subcommand) {
		case 'repos':
		case 'list':
			return listRepos(args.slice(1));
		case 'sync':
			return syncRepos(args.slice(1));
		case 'help':
		default:
			printHelp();
			return;
	}
}

function printHelp(): void {
	console.log(`${bold('Usage:')} hoststack github <command>`);
	console.log('');
	console.log('Commands:');
	console.log(`  ${bold('repos')}  List the connected repositories, with the id a service takes`);
	console.log(
		`  ${bold('sync')}   Re-sync repositories from GitHub for the connected installation(s)`,
	);
	console.log('');
	console.log(
		dim('Run `hoststack github sync` after pushing a new repo so HostStack can see it.'),
	);
}

/**
 * Re-sync the repo list for every connected GitHub App installation. Wraps
 * POST /api/github/:teamId/installations/:id/sync — previously only reachable
 * from the dashboard's refresh icon, so a CLI-only workflow couldn't pick up a
 * freshly-pushed repo.
 */
async function syncRepos(_args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const s = spinner('Syncing GitHub repositories...');
	try {
		const { installations } = await apiFetch<{ installations: Installation[] }>(
			`/api/github/${teamId}/installations`,
		);

		if (installations.length === 0) {
			s.stop(red('No GitHub installations connected'));
			console.error(
				dim(
					'Connect the HostStack GitHub App from the dashboard (Settings → GitHub) first.',
				),
			);
			process.exit(1);
		}

		let total = 0;
		for (const inst of installations) {
			const { repos } = await apiFetch<{ repos: SyncedRepo[] }>(
				`/api/github/${teamId}/installations/${inst.id}/sync`,
				{ method: 'POST' },
			);
			total += repos.length;
			console.log(
				`${green('✓')} ${bold(inst.accountLogin)} ${dim(`(${repos.length} repos)`)}`,
			);
		}
		s.stop(`Synced ${total} repositories across ${installations.length} installation(s)`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/**
 * The connected repositories, and the id `create_service` wants.
 *
 * That id is a HostStack row id — not the one GitHub shows — and until this
 * command it was readable from the dashboard's repo picker and nowhere else,
 * which left an API-only caller guessing a number that the create endpoint
 * accepted without checking. Wraps GET /api/github/:teamId/repos.
 */
async function listRepos(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');
	const needle = args.find((a) => !a.startsWith('-'))?.toLowerCase();

	try {
		const { repos } = await apiFetch<{ repos: ConnectedRepo[] }>(`/api/github/${teamId}/repos`);
		const matched = (
			needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos
		).sort((a, b) => a.fullName.localeCompare(b.fullName));

		if (jsonFlag) {
			console.log(JSON.stringify(matched, null, 2));
			return;
		}

		if (repos.length === 0) {
			console.log(dim('No repositories connected.'));
			console.log(
				dim(
					'Install the HostStack GitHub App (Settings → GitHub), then run `hoststack github sync`.',
				),
			);
			return;
		}
		if (matched.length === 0) {
			console.log(dim(`No connected repository matches "${needle}".`));
			console.log(dim('Pushed it just now? Run `hoststack github sync` first.'));
			return;
		}

		console.log(
			table(
				['ID', 'REPOSITORY', 'DEFAULT BRANCH', 'VISIBILITY'],
				matched.map((r) => [
					String(r.id),
					r.fullName,
					r.defaultBranch,
					r.isPrivate ? 'private' : 'public',
				]),
			),
		);
		console.log('');
		console.log(
			dim('Use the ID as `githubRepoId`, or pass `githubRepo: "owner/name"` instead.'),
		);
	} catch (err) {
		handleError(err);
	}
}
