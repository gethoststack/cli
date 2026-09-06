import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, green, handleError, red, spinner } from '../lib/output.ts';

interface Installation {
	id: number;
	accountLogin: string;
}

interface SyncedRepo {
	id: number;
	fullName: string;
}

export async function githubCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'help';

	switch (subcommand) {
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
