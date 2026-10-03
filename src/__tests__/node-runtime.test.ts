import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

/**
 * The CLI is BUILT by Bun but RUNS under Node.
 *
 * `tsup.config.ts` sets `platform: 'node'`, `target: 'node18'` and a
 * `#!/usr/bin/env node` banner; package.json declares `engines.node >= 18` and
 * `bin.hoststack -> dist/index.js`. So an `npm i -g @hoststack.dev/cli` install
 * is executed by Node, and a Bun global in the source is not a build error —
 * the bundler leaves `Bun.file(...)` in place as a free variable and it becomes
 * a `ReferenceError: Bun is not defined` in the user's terminal.
 *
 * That is not hypothetical. `task add --body-file` shipped reading its input
 * with `Bun.file()` / `Bun.stdin.stream()`, so BOTH documented forms of the
 * flag — a path and `-` for stdin — crashed for every npm install, while
 * working perfectly for anyone who happened to run the bundle with `bun`.
 * The whole test suite runs under Bun, so nothing in it could see the defect.
 *
 * Hence this file: it exercises the built artifact through the runtime that
 * actually ships it. It deliberately does NOT skip when the bundle is missing —
 * it builds it — because a conditionally-skipped runtime test is exactly the
 * shape of green suite that let this through the first time.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');

/** Bun globals are legal in the test files (they run under Bun) — nowhere else. */
function shippedSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...shippedSources(full));
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

describe('the shipped CLI source targets Node', () => {
	test('no Bun global or bun: import survives into a Node-executed path', () => {
		// The SDK is NOT inlined into dist/index.js — tsup externalises
		// `dependencies`, so npm installs it alongside the bundle. Either way
		// the same Node process executes its code, so it is held to the same rule.
		const files = [
			...shippedSources(join(CLI_ROOT, 'src')),
			...shippedSources(join(REPO_ROOT, 'packages', 'sdk', 'src')),
		];
		expect(files.length).toBeGreaterThan(10);

		const offenders: string[] = [];
		for (const file of files) {
			readFileSync(file, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					// Skip comments: this file's own rationale names `Bun.file`.
					const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
					if (/\bBun\s*\./.test(code) || /from\s+['"]bun(:|['"])/.test(code)) {
						offenders.push(
							`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`,
						);
					}
				});
		}
		expect(offenders).toEqual([]);
	});
});

/**
 * Reproduce the layout an `npm i -g @hoststack.dev/cli` leaves on disk.
 *
 * tsup externalises everything in `dependencies`, so `@hoststack.dev/sdk`
 * survives in dist/index.js as a bare import and npm installs it ALONGSIDE the
 * bundle. Node resolves a bare specifier by walking UP from the importing file,
 * so the temp dir needs a node_modules of its own; without one the run borrows
 * whatever happens to sit above `os.tmpdir()` and proves nothing about the
 * artifact either way.
 *
 * That is not hypothetical. A dev box points TMPDIR at `/workspace/.cache/tmp`,
 * which has held a symlink to ANOTHER CHECKOUT's node_modules — so the test
 * passed while silently resolving a different commit's SDK, and failed on any
 * box without that stray link. Nearest-node_modules-wins, so building the
 * layout here pins resolution to this checkout.
 *
 * Workspace deps are COPIED (`package.json` + `dist/` — exactly the package's
 * `files`) rather than symlinked: Node resolves a symlink to its realpath,
 * which would put the dependency back inside the repo and let its own imports
 * escape into the repo's node_modules — the same accident, one level down.
 */
function installDependencies(root: string) {
	const manifest = (file: string) =>
		JSON.parse(readFileSync(file, 'utf8')) as {
			name: string;
			dependencies?: Record<string, string>;
		};

	// name -> directory for every workspace package. Keyed on the DECLARED name,
	// not the path: `@hoststack/shared` does not share the published scope.
	const workspaces = new Map<string, string>();
	const packagesDir = join(REPO_ROOT, 'packages');
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		const dir = join(packagesDir, entry.name);
		if (entry.isDirectory() && existsSync(join(dir, 'package.json'))) {
			workspaces.set(manifest(join(dir, 'package.json')).name, dir);
		}
	}

	// Transitively, because npm is: a workspace dependency's own `dependencies`
	// are installed for the user too, so leaving them out would fail a run that
	// a real install would survive.
	const installed = new Set<string>();
	const pending = [join(CLI_ROOT, 'package.json')];
	while (pending.length > 0) {
		for (const dep of Object.keys(manifest(pending.pop()!).dependencies ?? {})) {
			if (installed.has(dep)) continue;
			installed.add(dep);

			const dest = join(root, 'node_modules', dep);
			mkdirSync(dirname(dest), { recursive: true });
			const workspace = workspaces.get(dep);
			if (workspace) {
				mkdirSync(dest, { recursive: true });
				cpSync(join(workspace, 'package.json'), join(dest, 'package.json'));
				cpSync(join(workspace, 'dist'), join(dest, 'dist'), { recursive: true });
				pending.push(join(dest, 'package.json'));
			} else {
				// A registry dependency — npm would fetch it, so borrow the real
				// install. Its own tree resolves through the symlink's realpath.
				symlinkSync(join(REPO_ROOT, 'node_modules', dep), dest);
			}
			expect(
				existsSync(join(dest, 'package.json')),
				`${dep} is a runtime dependency of the shipped CLI but did not install into the test's node_modules`,
			).toBe(true);
		}
	}
}

describe('the built bundle runs under Node', () => {
	let home: string;
	let bundle: string;
	let bodyFile: string;
	let server: ReturnType<typeof Bun.serve>;
	let received: Array<{ projectId: number; title: string; body?: string }>;
	const BODY = '# Report\n\nA long brief with "quotes", æøå and\nnewlines.\n';

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), 'hoststack-cli-node-'));

		// The SDK is a workspace dependency of the bundle; build it if a bare
		// checkout has not yet (the `typecheck` script does this too).
		if (!existsSync(join(REPO_ROOT, 'packages', 'sdk', 'dist', 'index.js'))) {
			const sdk = spawnSync('bun', ['run', 'build'], {
				cwd: join(REPO_ROOT, 'packages', 'sdk'),
				encoding: 'utf8',
			});
			expect(sdk.status, `sdk build failed:\n${sdk.stderr}`).toBe(0);
		}
		// Built through tsup.config.ts — the SAME config that produces the npm
		// artifact, so `platform: node` and the shebang are the real ones — but
		// into a temp dir rather than `dist/`. A test that rewrote `dist/` would
		// mutate the working tree mid-run, and dev-ci keys its cached results by
		// the content of that tree.
		bundle = join(home, 'dist', 'index.js');
		const build = spawnSync('bunx', ['tsup', '--out-dir', join(home, 'dist')], {
			cwd: CLI_ROOT,
			encoding: 'utf8',
		});
		expect(build.status, `cli build failed:\n${build.stderr}`).toBe(0);
		expect(existsSync(bundle)).toBe(true);
		installDependencies(home);
		mkdirSync(join(home, '.hoststack'), { recursive: true });
		bodyFile = join(home, 'report.md');
		writeFileSync(bodyFile, BODY, 'utf8');

		received = [];
		server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.startsWith('/api/dev-env-tasks/')) {
					const sent = (await req.json()) as {
						projectId: number;
						title: string;
						body?: string;
					};
					received.push(sent);
					return Response.json({
						task: {
							id: 1,
							publicId: 'task_stub',
							title: sent.title,
							status: 'idea',
							serviceId: null,
						},
					});
				}
				return Response.json({});
			},
		});
	}, 180_000);

	afterAll(() => {
		server?.stop(true);
		if (home) rmSync(home, { recursive: true, force: true });
	});

	/**
	 * Spawned ASYNCHRONOUSLY, not with `spawnSync`. The stub above serves from
	 * this same event loop, so a synchronous wait deadlocks: the CLI's request
	 * arrives at a thread that is blocked waiting for the CLI to exit.
	 *
	 * The environment is minimal and EXPLICIT. Inheriting `process.env` would be
	 * a live grenade: a dev box presets `HOSTSTACK_API_URL`/`HOSTSTACK_API_KEY`
	 * at the real control plane and both outrank the config file, so an
	 * inherited env aims this test at production and files real tasks on the
	 * team's account.
	 */
	async function runNode(args: string[], stdin?: string) {
		const child = Bun.spawn(['node', bundle, ...args], {
			stdin: new TextEncoder().encode(stdin ?? ''),
			stdout: 'pipe',
			stderr: 'pipe',
			env: {
				PATH: process.env.PATH ?? '',
				HOME: home,
				HOSTSTACK_API_URL: `http://127.0.0.1:${server.port}`,
				HOSTSTACK_API_KEY: 'hs_test_stub',
				HOSTSTACK_TEAM_ID: '1',
			},
		});
		const [stdout, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, status };
	}

	test('node is what the bundle claims to need', () => {
		const probe = spawnSync('node', ['--version'], { encoding: 'utf8' });
		expect(probe.status, 'node is required to test the artifact npm ships').toBe(0);
		expect(readFileSync(bundle, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
	});

	test('task add --body-file <path> reads the file', async () => {
		const run = await runNode([
			'task',
			'add',
			'--project',
			'1',
			'--body-file',
			bodyFile,
			'From a file',
		]);
		expect(run.stderr).not.toContain('Bun is not defined');
		expect(run.status, `stderr:\n${run.stderr}`).toBe(0);
		expect(received.at(-1)).toEqual({ projectId: 1, title: 'From a file', body: BODY });
	});

	test('a mistyped --body-file path fails as a CLI error, not a node stack', async () => {
		const run = await runNode([
			'task',
			'add',
			'--project',
			'1',
			'--body-file',
			join(home, 'does-not-exist.md'),
			'Typo',
		]);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('ENOENT');
		expect(run.stderr).not.toContain('node:internal');
	});

	test('task add --body-file - reads stdin', async () => {
		const run = await runNode(
			['task', 'add', '--project', '1', '--body-file', '-', 'From stdin'],
			BODY,
		);
		expect(run.stderr).not.toContain('Bun is not defined');
		expect(run.status, `stderr:\n${run.stderr}`).toBe(0);
		expect(received.at(-1)).toEqual({ projectId: 1, title: 'From stdin', body: BODY });
	});
});
