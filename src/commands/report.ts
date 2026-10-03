import { readFile } from 'node:fs/promises';
import { text as readStream } from 'node:stream/consumers';

import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, cyan, dim, handleError, red, spinner } from '../lib/output.ts';
import { resolveServiceId } from '../lib/resolve.ts';

/**
 * File a platform fault with the HostStack team.
 *
 * This is for something on the PLATFORM being broken in a way you cannot act
 * on from where you stand — a deploy that fails identically whatever you
 * change, a box that will not start, an API returning the wrong thing. It is
 * not for a bug in your own code, and it is not a first move: it is what you
 * do once you have a specific fault and nothing left to try.
 *
 * Diagnostic context is attached SERVER-SIDE. Naming a service attaches the
 * service, its most recent deploy, and the tail of that deploy's log — so the
 * useful part of a report is what you observed and what you expected, not a
 * pasted log you had to go and fetch.
 */

const SEVERITIES = ['low', 'normal', 'high', 'urgent'];

interface Ticket {
	id: number;
	publicId: string;
}

export async function reportCommand(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}

	// The title is the first bare word-run; everything structured is a flag.
	const title =
		flag(args, '--title') ?? (args[0] && !args[0].startsWith('--') ? args[0] : undefined);
	const rawDescription = flag(args, '--description') ?? flag(args, '-d');

	if (!title || rawDescription === undefined) {
		printUsage();
		process.exit(1);
	}

	// `-` means stdin and `@path` means a file, which is how a log tail or a
	// paragraph with newlines gets in without fighting the shell.
	//
	// Node APIs, not `Bun.stdin` / `Bun.file`: this bundle ships to npm with a
	// `#!/usr/bin/env node` banner, so a Bun global here is a `ReferenceError:
	// Bun is not defined` for every user who installed the documented way —
	// invisible to a test suite that runs under Bun. `task add --body-file`
	// shipped exactly that bug once already.
	let description = rawDescription;
	try {
		if (rawDescription === '-') description = (await readStream(process.stdin)).trim();
		else if (rawDescription.startsWith('@'))
			description = (await readFile(rawDescription.slice(1), 'utf8')).trim();
	} catch (err) {
		// Outside the request try/catch below: a mistyped path should not exit
		// on a raw ENOENT stack out of node:internal.
		handleError(err);
	}
	if (description.length === 0) {
		console.error(red('The description is empty. Say what happened and what you expected.'));
		process.exit(1);
	}

	const severity = flag(args, '--severity') ?? 'normal';
	if (!SEVERITIES.includes(severity)) {
		console.error(red(`Unknown severity "${severity}". One of: ${SEVERITIES.join(', ')}.`));
		process.exit(1);
	}
	if (severity === 'high' || severity === 'urgent') {
		// Stated, not enforced. Severity is a claim on somebody's evening and
		// the person typing it is the only one who can judge it.
		console.log(dim(`Filing as ${severity} — for something DOWN or losing data.`));
	}

	const body: Record<string, unknown> = { title, description, severity };

	const serviceRef = flag(args, '--service');
	if (serviceRef !== undefined) {
		body.serviceId = await resolveServiceId(teamId, serviceRef);
	}
	const databaseRef = flag(args, '--database');
	if (databaseRef !== undefined) {
		body.databaseId = await resolveDatabaseId(teamId, databaseRef);
	}

	const s = spinner('Filing...');
	try {
		const { ticket } = await apiFetch<{ ticket: Ticket }>(`/api/issue-reports/${teamId}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		s.stop(`Filed as ${bold(ticket.publicId)}`);
		console.log();
		if (serviceRef !== undefined) {
			console.log(dim('The service, its latest deploy and that deploy log went with it.'));
		}
		console.log(`Follow it up with that reference. ${dim('Do not file this one twice.')}`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

function printUsage(): void {
	console.log(
		`${bold('Usage:')} hoststack report "<title>" --description <text|-> [--severity ${SEVERITIES.join('|')}] [--service <id|svc_…>] [--database <id|db_…>]`,
	);
	console.log();
	console.log('Reports a fault in the PLATFORM to the HostStack team.');
	console.log();
	console.log(dim('  --description -   reads the description from stdin (for a log tail)'));
	console.log(dim('  --description @f  reads it from the file f'));
	console.log(
		dim('  --service         attaches the service, its latest deploy, and that deploy log'),
	);
	console.log(dim('  --severity        default normal; high/urgent mean DOWN or losing data'));
	console.log();
	console.log(`${bold('Write it so it can be acted on.')}`);
	console.log(
		dim('  "the deploy failed" is worth less than no report. What you observed, what you'),
	);
	console.log(dim('  expected instead, and what you already ruled out.'));
	console.log();
	console.log(`${bold('Examples:')}`);
	console.log(
		dim(
			'  hoststack report "Deploys fail at container create with 404 No such image" \\\n' +
				'      --service svc_abc --severity high \\\n' +
				'      --description "Every deploy since 09:03 fails at container create with 404 No\n' +
				"      such image. The log says 'Image ready in 1s' for a 5.5 GB image, so the pull\n" +
				'      is not happening. The image pulls fine by hand from the same registry."',
		),
	);
	console.log(dim('  journalctl -u thing | tail -50 | hoststack report "…" --description -'));
	console.log();
	console.log(
		`Not a platform fault? ${cyan('hoststack errors')} is for exceptions your app reported.`,
	);
	console.log(dim('Rate-limited to 5 reports per minute.'));
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	const value = args[idx + 1];
	// A description legitimately starts with a dash only when it is the `-`
	// stdin marker; anything else beginning `--` is the next flag.
	if (value === undefined) return undefined;
	if (value === '-') return value;
	return value.startsWith('--') ? undefined : value;
}

/** The report API keys off numeric ids, so a `db_…` has to be resolved first. */
async function resolveDatabaseId(teamId: number, ref: string): Promise<number> {
	if (/^\d+$/.test(ref)) return Number(ref);
	try {
		const { database } = await apiFetch<{ database: { id: number } }>(
			`/api/databases/${teamId}/${ref}`,
		);
		return database.id;
	} catch {
		console.error(red(`Database "${ref}" not found in this team.`));
		process.exit(1);
	}
}
