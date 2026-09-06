import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// $HOME is pointed at a private temp dir in `beforeEach`, NOT here.
//
// The comment that used to sit at this spot said the assignment below happens
// "BEFORE importing the config-bound modules". It does not: ESM imports are
// HOISTED above every statement in the file, so `../lib/config.ts` was already
// evaluated by the time this line ran. That module then froze the developer's
// real home in a constant, and the whole suite wrote to
// `~/.hoststack/config.json` — logging you out of the CLI, and racing the other
// seven shards badly enough to redden the deploy gate about half the time.
//
// The module resolves its path per call now (see lib/config.ts), so the only
// thing that matters is that $HOME is correct WHILE A TEST RUNS, and
// `beforeEach` is where that is true. It also survives a sibling file's
// `afterAll` restoring $HOME mid-suite, which a module-level assignment cannot.
//
// The assignment below is kept because import-time code in the modules under
// test may still read the environment; it is no longer what makes these tests
// correct.
const tmp = mkdtempSync(join(tmpdir(), 'hoststack-cli-cmd-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
delete process.env.HOSTSTACK_API_KEY;
delete process.env.HOSTSTACK_API_URL;
delete process.env.HOSTSTACK_TEAM_ID;
mkdirSync(join(tmp, '.hoststack'), { recursive: true });

import { deployCommand } from '../commands/deploy.ts';
import { devCommand } from '../commands/dev.ts';
import { domainsCommand } from '../commands/domains.ts';
import { envCommand } from '../commands/env.ts';
import { initCommand } from '../commands/init.ts';
import { loginCommand } from '../commands/login.ts';
import { machinesCommand } from '../commands/machines.ts';
import { projectsCommand } from '../commands/projects.ts';
import { servicesCommand } from '../commands/services.ts';
import { validateCommand } from '../commands/validate.ts';
import { whoamiCommand } from '../commands/whoami.ts';
import { saveConfig } from '../lib/config.ts';

// Re-pointed before EVERY test, so neither import hoisting nor a sibling
// file's cleanup can leave a test reading or writing the real
// `~/.hoststack`.
beforeEach(() => {
	process.env.HOME = tmp;
	delete process.env.HOSTSTACK_API_KEY;
	delete process.env.HOSTSTACK_API_URL;
	delete process.env.HOSTSTACK_TEAM_ID;
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;
});

// ── Shared stubs ──────────────────────────────────────────────────────────
interface Capture {
	out: string[];
	err: string[];
	exitCode: number | null;
}

function captureIO(): {
	cap: Capture;
	restore: () => void;
} {
	const cap: Capture = { out: [], err: [], exitCode: null };
	const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		cap.out.push(args.map(String).join(' '));
	});
	const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		cap.err.push(args.map(String).join(' '));
	});
	const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
		cap.exitCode = code ?? 0;
		throw new Error(`__exit__:${cap.exitCode}`);
	}) as unknown as typeof process.exit);
	return {
		cap,
		restore: () => {
			logSpy.mockRestore();
			errSpy.mockRestore();
			exitSpy.mockRestore();
		},
	};
}

const globalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;

function installFetch(fn: (url: string, init?: RequestInit) => Response) {
	fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) =>
		Promise.resolve(fn(url, init))) as unknown as typeof fetch);
}

afterEach(() => {
	if (fetchSpy) {
		fetchSpy.mockRestore();
		fetchSpy = null;
	}
	globalThis.fetch = globalFetch;
});

// ── initCommand ──────────────────────────────────────────────────────────
describe('initCommand', () => {
	let workdir: string;
	const origCwd = process.cwd();
	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), 'hoststack-init-'));
		process.chdir(workdir);
	});
	afterEach(() => {
		process.chdir(origCwd);
		rmSync(workdir, { recursive: true, force: true });
	});

	test('creates hoststack.yaml with a template', async () => {
		const { cap, restore } = captureIO();
		try {
			await initCommand([]);
			expect(existsSync(join(workdir, 'hoststack.yaml'))).toBe(true);
			expect(readFileSync(join(workdir, 'hoststack.yaml'), 'utf-8')).toContain('services:');
			expect(cap.out.some((l) => l.includes('Created'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('refuses to overwrite without --force', async () => {
		writeFileSync(join(workdir, 'hoststack.yaml'), '# existing\n');
		const { cap, restore } = captureIO();
		try {
			try {
				await initCommand([]);
			} catch {
				/* expected process.exit */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('already exists'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('overwrites when --force is passed', async () => {
		writeFileSync(join(workdir, 'hoststack.yaml'), '# old\n');
		const { restore } = captureIO();
		try {
			await initCommand(['--force']);
			const content = readFileSync(join(workdir, 'hoststack.yaml'), 'utf-8');
			expect(content).toContain('services:');
			expect(content).not.toContain('# old');
		} finally {
			restore();
		}
	});
});

// ── validateCommand ──────────────────────────────────────────────────────
describe('validateCommand', () => {
	let workdir: string;
	const origCwd = process.cwd();
	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), 'hoststack-validate-'));
		process.chdir(workdir);
	});
	afterEach(() => {
		process.chdir(origCwd);
		rmSync(workdir, { recursive: true, force: true });
	});

	test('errors when no config file is present', async () => {
		const { cap, restore } = captureIO();
		try {
			try {
				await validateCommand([]);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			const joined = cap.err.join(' ');
			expect(joined).toMatch(/No/);
			expect(joined).toMatch(/hoststack\.yaml/);
		} finally {
			restore();
		}
	});

	test('passes on a valid config', async () => {
		writeFileSync(
			join(workdir, 'hoststack.yaml'),
			'services:\n  web:\n    type: web_service\n    port: 3000\n',
		);
		const { cap, restore } = captureIO();
		try {
			await validateCommand([]);
			expect(cap.exitCode).toBeNull();
			expect(cap.out.some((l) => l.includes('is valid'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('fails with a specific error for bad service type', async () => {
		writeFileSync(join(workdir, 'hoststack.yaml'), 'services:\n  web:\n    type: bogus_type\n');
		const { cap, restore } = captureIO();
		try {
			try {
				await validateCommand([]);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('services.web.type'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('fails when scaling.min > scaling.max', async () => {
		writeFileSync(
			join(workdir, 'hoststack.yaml'),
			'services:\n  web:\n    type: web_service\n    scaling:\n      min: 5\n      max: 2\n',
		);
		const { cap, restore } = captureIO();
		try {
			try {
				await validateCommand([]);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('min cannot be greater than max'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('fails when a database has no engine', async () => {
		writeFileSync(join(workdir, 'hoststack.yaml'), 'databases:\n  main:\n    version: "16"\n');
		const { cap, restore } = captureIO();
		try {
			try {
				await validateCommand([]);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('databases.main.engine'))).toBe(true);
		} finally {
			restore();
		}
	});
});

// ── whoamiCommand ─────────────────────────────────────────────────────────
describe('whoamiCommand', () => {
	test('prints user and team info from /api/auth/me', async () => {
		saveConfig({ apiKey: 'hs_test_x' });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						user: { id: 1, name: 'Alice', email: 'alice@test.com' },
						team: { id: 42, name: 'Acme', slug: 'acme', role: 'owner' },
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await whoamiCommand();
			expect(cap.out.some((l) => l.includes('Alice'))).toBe(true);
			expect(cap.out.some((l) => l.includes('Acme'))).toBe(true);
			expect(cap.out.some((l) => l.includes('owner'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('exits when not authenticated', async () => {
		saveConfig({});
		delete process.env.HOSTSTACK_API_KEY;
		const { cap, restore } = captureIO();
		try {
			try {
				await whoamiCommand();
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.toLowerCase().includes('not authenticated'))).toBe(true);
		} finally {
			restore();
		}
	});
});

// ── projectsCommand — list ─────────────────────────────────────────────────
describe('projectsCommand list', () => {
	test('renders a table when projects exist', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						projects: [
							{
								id: 1,
								publicId: 'prj_abc',
								name: 'Billing',
								slug: 'billing',
								region: 'eu-central',
								createdAt: new Date('2026-01-01').toISOString(),
							},
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await projectsCommand(['list']);
			const output = cap.out.join('\n');
			expect(output).toContain('prj_abc');
			expect(output).toContain('Billing');
			expect(output).toContain('eu-central');
		} finally {
			restore();
		}
	});

	test('--json prints raw JSON', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						projects: [
							{
								id: 1,
								publicId: 'prj_x',
								name: 'X',
								region: 'eu',
								createdAt: '2026-01-01',
							},
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await projectsCommand(['list', '--json']);
			const output = cap.out.join('\n');
			expect(output).toContain('"publicId": "prj_x"');
		} finally {
			restore();
		}
	});

	test('empty list prints helpful hint', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(JSON.stringify({ projects: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		const { cap, restore } = captureIO();
		try {
			await projectsCommand(['list']);
			expect(cap.out.some((l) => l.includes('No projects'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('errors when no team selected', async () => {
		saveConfig({ apiKey: 'hs_test_x' });
		delete process.env.HOSTSTACK_TEAM_ID;
		const { cap, restore } = captureIO();
		try {
			try {
				await projectsCommand(['list']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.toLowerCase().includes('no team selected'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('projects create without --name shows usage and exits', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await projectsCommand(['create']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('unknown subcommand prints usage and exits', async () => {
		const { cap, restore } = captureIO();
		try {
			try {
				await projectsCommand(['not-a-command']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.out.some((l) => l.includes('Usage:'))).toBe(true);
		} finally {
			restore();
		}
	});
});

// ── loginCommand ──────────────────────────────────────────────────────────
describe('loginCommand', () => {
	test('prints usage and exits when --key missing', async () => {
		const { cap, restore } = captureIO();
		try {
			try {
				await loginCommand([]);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.out.some((l) => l.includes('Usage:'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('exits 1 when API key is rejected', async () => {
		installFetch(() => new Response('', { status: 401 }));
		const { cap, restore } = captureIO();
		try {
			try {
				await loginCommand(['--key', 'hs_test_bad']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('saves config on successful validation', async () => {
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						user: { name: 'Alice', email: 'a@test.com' },
						team: { id: 99, name: 'Acme' },
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await loginCommand(['--key', 'hs_test_good']);
			expect(cap.out.some((l) => l.includes('Logged in'))).toBe(true);
			expect(cap.out.some((l) => l.includes('Alice'))).toBe(true);
			expect(cap.out.some((l) => l.includes('Acme'))).toBe(true);
		} finally {
			restore();
		}
	});
});

// ── servicesCommand ───────────────────────────────────────────────────────
describe('servicesCommand', () => {
	test('list renders a table with status badges', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						services: [
							{
								id: 1,
								publicId: 'svc_abc',
								name: 'api',
								type: 'web_service',
								status: 'running',
								projectId: 1,
								createdAt: '2026-01-01',
							},
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list']);
			const out = cap.out.join('\n');
			expect(out).toContain('svc_abc');
			expect(out).toContain('api');
		} finally {
			restore();
		}
	});

	test('scale rejects non-numeric spec', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['scale', 'svc_1', 'not-a-number']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.toLowerCase().includes('invalid scale spec'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('scale rejects negative min', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['scale', 'svc_1', '-1']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('scale rejects max < min', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['scale', 'svc_1', '5:2']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('scale sends minInstances + maxInstances (single N)', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let captured: { url: string; body: string | undefined } | null = null;
		installFetch((url, init) => {
			captured = { url, body: init?.body as string | undefined };
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['scale', 'svc_1', '3']);
			expect(captured).not.toBeNull();
			const { url, body } = captured as unknown as { url: string; body: string };
			expect(url).toContain('/config');
			const parsed = JSON.parse(body) as Record<string, unknown>;
			expect(parsed).toEqual({ minInstances: 3, maxInstances: 3 });
			// Spinner output writes directly to process.stdout, not console.log;
			// the value being sent over the wire is the assertion that matters.
			void cap;
		} finally {
			restore();
		}
	});

	test('scale sends min:max range', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let captured: { body: string | undefined } | null = null;
		installFetch((_url, init) => {
			captured = { body: init?.body as string | undefined };
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await servicesCommand(['scale', 'svc_1', '2:5']);
			const parsed = JSON.parse((captured as unknown as { body: string }).body) as Record<
				string,
				unknown
			>;
			expect(parsed).toEqual({ minInstances: 2, maxInstances: 5 });
		} finally {
			restore();
		}
	});

	// ── services update ──────────────────────────────────────────────────
	// The gap these cover: service config was reachable only from MCP or the
	// dashboard, so a repeatable setup that has to flip auto-deploy could not
	// be written as a shell script at all.

	test('update with no flags refuses instead of sending an empty PATCH', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['update', 'svc_1']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(called).toBe(false);
			expect(cap.err.some((l) => l.includes('Nothing to update'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('update --no-auto-deploy PATCHes the service row only', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		installFetch((url, init) => {
			calls.push({
				url,
				method: init?.method,
				body: init?.body as string | undefined,
			});
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await servicesCommand(['update', 'svc_1', '--no-auto-deploy']);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.method).toBe('PATCH');
			expect(calls[0]!.url).toContain('/api/services/42/svc_1');
			expect(calls[0]!.url).not.toContain('/config');
			expect(JSON.parse(calls[0]!.body!)).toEqual({ autoDeploy: false });
		} finally {
			restore();
		}
	});

	test('update routes config fields to /config and repo fields to the row', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; body?: string }[] = [];
		installFetch((url, init) => {
			calls.push({ url, body: init?.body as string | undefined });
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await servicesCommand([
				'update',
				'svc_1',
				'--branch',
				'main',
				'--health-check-grace',
				'180',
			]);
			expect(calls).toHaveLength(2);
			expect(JSON.parse(calls[0]!.body!)).toEqual({ branch: 'main' });
			expect(calls[1]!.url).toContain('/config');
			expect(JSON.parse(calls[1]!.body!)).toEqual({ healthCheckGracePeriodSec: 180 });
		} finally {
			restore();
		}
	});

	test('update clears a nullable field with an empty string', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let body = '';
		installFetch((_url, init) => {
			body = init?.body as string;
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await servicesCommand(['update', 'svc_1', '--build-command', '']);
			expect(JSON.parse(body)).toEqual({ buildCommand: null });
		} finally {
			restore();
		}
	});

	test('update --instances pins both bounds', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let body = '';
		installFetch((_url, init) => {
			body = init?.body as string;
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await servicesCommand(['update', 'svc_1', '--instances', '2']);
			expect(JSON.parse(body)).toEqual({ minInstances: 2, maxInstances: 2 });
		} finally {
			restore();
		}
	});

	test('update rejects a non-numeric number flag before sending anything', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['update', 'svc_1', '--memory-mb', 'lots']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(called).toBe(false);
			expect(cap.err.some((l) => l.includes('--memory-mb'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('update refuses a flag whose value is missing', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['update', 'svc_1', '--branch', '--no-auto-deploy']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('--branch needs a value'))).toBe(true);
		} finally {
			restore();
		}
	});

	// ── services list --repo / --branch / --auto-deploy ───────────────────
	// dev-ship's setup guard is the caller: it asks "does the platform already
	// deploy this repo on push?" before cloning a shipper checkout that would
	// double every deploy.

	const REPO_FIXTURE = {
		services: [
			{
				id: 1,
				publicId: 'svc_auto',
				name: 'api',
				type: 'web_service',
				status: 'running',
				projectId: 1,
				createdAt: '2026-01-01',
				branch: 'master',
				autoDeploy: true,
				githubRepoId: 7,
			},
			{
				id: 2,
				publicId: 'svc_manual',
				name: 'worker',
				type: 'worker',
				status: 'running',
				projectId: 1,
				createdAt: '2026-01-01',
				branch: 'master',
				autoDeploy: false,
				githubRepoId: 7,
			},
			{
				id: 3,
				publicId: 'svc_other',
				name: 'unrelated',
				type: 'web_service',
				status: 'running',
				projectId: 1,
				createdAt: '2026-01-01',
				branch: 'master',
				autoDeploy: true,
				githubRepoId: 9,
			},
		],
	};
	const REPOS_FIXTURE = {
		repos: [
			{ id: 7, fullName: 'acme/app', cloneUrl: 'https://github.com/acme/app.git' },
			{ id: 9, fullName: 'acme/other', cloneUrl: 'https://github.com/acme/other.git' },
		],
	};

	function installRepoFetch(): () => number {
		let repoCalls = 0;
		installFetch((url) => {
			if (url.includes('/api/github/')) {
				repoCalls++;
				return new Response(JSON.stringify(REPOS_FIXTURE), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response(JSON.stringify(REPO_FIXTURE), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		return () => repoCalls;
	}

	test('list --auto-deploy keeps only auto-deploying services and shows the column', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list', '--auto-deploy']);
			const out = cap.out.join('\n');
			expect(out).toContain('Auto-deploy');
			expect(out).toContain('svc_auto');
			expect(out).toContain('svc_other');
			expect(out).not.toContain('svc_manual');
		} finally {
			restore();
		}
	});

	test('list --no-auto-deploy is the complement, not "no filter"', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list', '--no-auto-deploy']);
			const out = cap.out.join('\n');
			expect(out).toContain('svc_manual');
			expect(out).not.toContain('svc_auto');
		} finally {
			restore();
		}
	});

	test.each([
		['acme/app'],
		['https://github.com/acme/app.git'],
		['git@github.com:acme/app.git'],
		['https://github.com/acme/app'],
	])('list --repo %s resolves the provider repo id', async (ref) => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list', '--repo', ref, '--json']);
			const rows = JSON.parse(cap.out.join('\n')) as { publicId: string }[];
			expect(rows.map((r) => r.publicId).sort()).toEqual(['svc_auto', 'svc_manual']);
		} finally {
			restore();
		}
	});

	test('list --repo --branch --auto-deploy is the dev-ship guard query', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand([
				'list',
				'--repo',
				'git@github.com:acme/app.git',
				'--branch',
				'master',
				'--auto-deploy',
				'--json',
			]);
			const rows = JSON.parse(cap.out.join('\n')) as { publicId: string }[];
			expect(rows.map((r) => r.publicId)).toEqual(['svc_auto']);
		} finally {
			restore();
		}
	});

	test('list --branch filters on the tracked branch', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list', '--branch', 'nope', '--json']);
			expect(JSON.parse(cap.out.join('\n'))).toEqual([]);
		} finally {
			restore();
		}
	});

	test('list --repo says no match rather than "no services"', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list', '--repo', 'acme/nothing']);
			expect(cap.out.join('\n')).toContain('No services match those filters');
		} finally {
			restore();
		}
	});

	test('list --repo survives a provider whose repo listing fails', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch((url) => {
			if (url.includes('/api/github/')) return new Response('nope', { status: 500 });
			return new Response(JSON.stringify(REPO_FIXTURE), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list', '--repo', 'acme/app', '--json']);
			// Unresolvable, so nothing matches — but the listing still answers
			// instead of failing the whole command.
			expect(JSON.parse(cap.out.join('\n'))).toEqual([]);
		} finally {
			restore();
		}
	});

	test('list without deploy filters keeps the original columns', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installRepoFetch();
		const { cap, restore } = captureIO();
		try {
			await servicesCommand(['list']);
			const out = cap.out.join('\n');
			expect(out).toContain('Created');
			expect(out).not.toContain('Auto-deploy');
		} finally {
			restore();
		}
	});

	test('create maps short --type "web" alias to web_service', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let captured: { body: string | undefined } | null = null;
		installFetch((_url, init) => {
			captured = { body: init?.body as string | undefined };
			return new Response(
				JSON.stringify({
					service: {
						id: 1,
						publicId: 'svc_abc',
						name: 'api',
						type: 'web_service',
						status: 'creating',
						projectId: 1,
						createdAt: '2026-01-01',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await servicesCommand(['create', '--name', 'api', '--type', 'web', '--project', '10']);
			const parsed = JSON.parse((captured as unknown as { body: string }).body) as Record<
				string,
				unknown
			>;
			expect(parsed.type).toBe('web_service');
			expect(parsed.projectId).toBe(10);
		} finally {
			restore();
		}
	});

	test('create rejects unknown --type', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand([
					'create',
					'--name',
					'api',
					'--type',
					'nope',
					'--project',
					'10',
				]);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.toLowerCase().includes('invalid --type'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('create resolves --project prj_… publicId via /api/projects list', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; body: string | undefined }> = [];
		installFetch((url, init) => {
			calls.push({ url, body: init?.body as string | undefined });
			if (url.includes('/api/projects/42') && !url.includes('/services')) {
				return new Response(
					JSON.stringify({ projects: [{ id: 77, publicId: 'prj_abc' }] }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response(
				JSON.stringify({
					service: {
						id: 1,
						publicId: 'svc_x',
						name: 'api',
						type: 'web_service',
						status: 'creating',
						projectId: 77,
						createdAt: '2026-01-01',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await servicesCommand([
				'create',
				'--name',
				'api',
				'--type',
				'web_service',
				'--project',
				'prj_abc',
			]);
			const createCall = calls.find((c) => c.body !== undefined);
			expect(createCall).toBeDefined();
			const parsed = JSON.parse(createCall!.body as string) as Record<string, unknown>;
			expect(parsed.projectId).toBe(77);
		} finally {
			restore();
		}
	});

	test('create without --name and --type prints usage', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['create']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('get without service id prints usage', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['get']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});
});

// ── deployCommand ─────────────────────────────────────────────────────────
describe('deployCommand', () => {
	test('trigger sends commitHash/branch and no clearCache field', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
		installFetch((url, init) => {
			calls.push({
				url,
				method: (init?.method ?? 'GET').toUpperCase(),
				body: init?.body as string | undefined,
			});
			return new Response(
				JSON.stringify({
					deploy: {
						id: 1,
						publicId: 'dpl_x',
						status: 'pending',
						trigger: 'api',
						createdAt: '2026-01-01',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await deployCommand(['trigger', 'svc_1', '--commit', 'abc123', '--branch', 'main']);
			const postCall = calls.find((c) => c.method === 'POST');
			expect(postCall).toBeDefined();
			const parsed = JSON.parse(postCall!.body as string) as Record<string, unknown>;
			expect(parsed).toEqual({ commitHash: 'abc123', branch: 'main' });
			expect(parsed.clearCache).toBeUndefined();
		} finally {
			restore();
		}
	});

	test('trigger --clear-cache wipes build cache before posting deploy', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string }> = [];
		installFetch((url, init) => {
			calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
			if (init?.method === 'DELETE') {
				return new Response('{}', {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response(
				JSON.stringify({
					deploy: {
						id: 1,
						publicId: 'dpl_x',
						status: 'pending',
						trigger: 'api',
						createdAt: '2026-01-01',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await deployCommand(['trigger', 'svc_1', '--clear-cache']);
			expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/build-cache'))).toBe(
				true,
			);
			expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/deploys'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('logs renders structured rows', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						logs: [
							{
								id: 1,
								level: 'info',
								phase: 'build',
								message: 'building image',
								timestamp: '2026-01-01T00:00:00.000Z',
							},
							{
								id: 2,
								level: 'error',
								phase: 'build',
								message: 'oom',
								timestamp: '2026-01-01T00:00:05.000Z',
							},
						],
						nextAfterId: 2,
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await deployCommand(['logs', 'svc_1', 'dpl_1']);
			const out = cap.out.join('\n');
			expect(out).toContain('building image');
			expect(out).toContain('oom');
			expect(out).not.toContain('[object Object]');
		} finally {
			restore();
		}
	});

	test('logs --json prints raw response', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						logs: [{ id: 1, level: 'info', message: 'hi' }],
						nextAfterId: 1,
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await deployCommand(['logs', 'svc_1', 'dpl_1', '--json']);
			const out = cap.out.join('\n');
			expect(out).toContain('"nextAfterId"');
		} finally {
			restore();
		}
	});
});

// ── envCommand ────────────────────────────────────────────────────────────
describe('envCommand', () => {
	test('list output includes id column', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						envVars: [
							{ id: 99, key: 'NODE_ENV', value: 'production', isSecret: false },
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await envCommand(['list', 'svc_1']);
			const out = cap.out.join('\n');
			expect(out).toContain('99');
			expect(out).toContain('NODE_ENV');
		} finally {
			restore();
		}
	});

	test('set creates a new var via POST when the key is absent', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body: string }> = [];
		installFetch((url, init) => {
			const method = (init?.method ?? 'GET').toUpperCase();
			calls.push({ url, method, body: String(init?.body ?? '') });
			if (method === 'GET') {
				return new Response(JSON.stringify({ envVars: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await envCommand(['set', 'svc_1', 'NODE_ENV=production']);
			const post = calls.find((c) => c.method === 'POST');
			expect(post).toBeDefined();
			expect(post?.url.endsWith('/env')).toBe(true);
			const body = JSON.parse(post?.body ?? '{}') as { key: string; isSecret: boolean };
			expect(body.key).toBe('NODE_ENV');
			expect(body.isSecret).toBe(false);
		} finally {
			restore();
		}
	});

	test('set updates an existing var via PATCH (upsert, no unique-violation)', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body: string }> = [];
		installFetch((url, init) => {
			const method = (init?.method ?? 'GET').toUpperCase();
			calls.push({ url, method, body: String(init?.body ?? '') });
			if (method === 'GET') {
				return new Response(
					JSON.stringify({
						envVars: [{ id: 7, key: 'NODE_ENV', value: 'old', isSecret: false }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await envCommand(['set', 'svc_1', 'NODE_ENV=staging']);
			expect(calls.some((c) => c.method === 'POST')).toBe(false);
			const patch = calls.find((c) => c.method === 'PATCH');
			expect(patch).toBeDefined();
			expect(patch?.url.endsWith('/env/7')).toBe(true);
			const body = JSON.parse(patch?.body ?? '{}') as { value: string; isSecret?: boolean };
			expect(body.value).toBe('staging');
			// No --secret flag → isSecret must NOT be sent (classification kept).
			expect('isSecret' in body).toBe(false);
		} finally {
			restore();
		}
	});

	test('set --secret --target forwards both on update', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ method: string; body: string }> = [];
		installFetch((_url, init) => {
			const method = (init?.method ?? 'GET').toUpperCase();
			calls.push({ method, body: String(init?.body ?? '') });
			if (method === 'GET') {
				return new Response(
					JSON.stringify({
						envVars: [{ id: 9, key: 'API_KEY', value: 'x', isSecret: false }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await envCommand(['set', 'svc_1', 'API_KEY=sk-123', '--secret', '--target', 'runtime']);
			const patch = calls.find((c) => c.method === 'PATCH');
			const body = JSON.parse(patch?.body ?? '{}') as {
				isSecret?: boolean;
				target?: string;
			};
			expect(body.isSecret).toBe(true);
			expect(body.target).toBe('runtime');
		} finally {
			restore();
		}
	});

	test('delete resolves KEY to numeric id then DELETEs', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string }> = [];
		installFetch((url, init) => {
			calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
			if (init?.method === undefined || init?.method === 'GET') {
				return new Response(
					JSON.stringify({
						envVars: [{ id: 12, key: 'API_TOKEN', value: '', isSecret: true }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await envCommand(['delete', 'svc_1', 'API_TOKEN']);
			expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/env/12'))).toBe(
				true,
			);
		} finally {
			restore();
		}
	});

	test('delete by numeric id skips the lookup', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string }> = [];
		installFetch((url, init) => {
			calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await envCommand(['delete', 'svc_1', '42']);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.method).toBe('DELETE');
			expect(calls[0]?.url.endsWith('/env/42')).toBe(true);
		} finally {
			restore();
		}
	});

	test('delete errors when key not found', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(JSON.stringify({ envVars: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		const { cap, restore } = captureIO();
		try {
			try {
				await envCommand(['delete', 'svc_1', 'MISSING_KEY']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('MISSING_KEY'))).toBe(true);
		} finally {
			restore();
		}
	});
});

// ── domainsCommand ────────────────────────────────────────────────────────
describe('domainsCommand', () => {
	test('add requires --service', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await domainsCommand(['add', 'example.com']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.out.some((l) => l.includes('--service'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('add forwards pathPrefix and resolves numeric service id', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let captured: { body: string | undefined } | null = null;
		installFetch((_url, init) => {
			captured = { body: init?.body as string | undefined };
			return new Response(
				JSON.stringify({
					domain: {
						id: 1,
						domain: 'example.com',
						status: 'pending',
						verified: false,
						createdAt: '2026-01-01',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await domainsCommand([
				'add',
				'example.com',
				'--service',
				'15',
				'--path-prefix',
				'/api',
			]);
			const parsed = JSON.parse((captured as unknown as { body: string }).body) as Record<
				string,
				unknown
			>;
			expect(parsed).toEqual({ domain: 'example.com', serviceId: 15, pathPrefix: '/api' });
		} finally {
			restore();
		}
	});
});

// ── devCommand ─────────────────────────────────────────────────────────────
describe('devCommand create', () => {
	function devEnvFetch(calls: { url: string; method?: string; body?: string }[]) {
		installFetch((url, init) => {
			calls.push({ url, method: init?.method, body: init?.body as string | undefined });
			if (url.includes('/env/bulk')) {
				return new Response('{}', {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('/volumes')) {
				return new Response(JSON.stringify({ volume: { id: 7, publicId: 'vol_x' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('/deploys')) {
				return new Response(JSON.stringify({ deploy: { id: 9 } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			// create service
			return new Response(
				JSON.stringify({
					service: {
						id: 5,
						publicId: 'svc_dev',
						name: 'dev-environment',
						type: 'private_service',
						status: 'not_deployed',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
	}

	test('orchestrates create(deferred) → volume → deploy from the dev-env image', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		devEnvFetch(calls);
		const { restore } = captureIO();
		try {
			await devCommand(['create', '--project', '1']);
		} finally {
			restore();
		}
		// First call creates the service: private_service from the dev-env image
		// with the first deploy deferred.
		const create = calls[0];
		expect(create?.method).toBe('POST');
		const createBody = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
		expect(createBody.type).toBe('private_service');
		// Registry-qualified (v148). A bare name resolves to Docker Hub, where
		// this image has never existed — which only worked because the machine
		// that builds it also runs the boxes. The API normalises any dev-env
		// image to its own constant anyway, so a stale published CLI still
		// lands on the right one; this asserts the CLI is not the stale side.
		expect(createBody.dockerImage).toBe('registry.hoststack.dev/hoststack/dev-env:latest');
		expect(createBody.autoDeploy).toBe(false);
		// Workspace volume attached at /workspace before the deploy.
		const volume = calls.find((c) => c.url.includes('/volumes'));
		expect(volume).toBeDefined();
		const volBody = JSON.parse(volume?.body ?? '{}') as Record<string, unknown>;
		expect(volBody.mountPath).toBe('/workspace');
		// First deploy fired last.
		const deploy = calls.find((c) => c.url.includes('/deploys'));
		expect(deploy).toBeDefined();
	});

	test('sets MCP keys as secret env vars when provided', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		devEnvFetch(calls);
		const { restore } = captureIO();
		try {
			await devCommand(['create', '--project', '1', '--hoststack-key', 'hs_live_abc']);
		} finally {
			restore();
		}
		const env = calls.find((c) => c.url.includes('/env/bulk'));
		expect(env).toBeDefined();
		const envBody = JSON.parse(env?.body ?? '{}') as {
			vars: { key: string; isSecret: boolean }[];
		};
		const row = envBody.vars.find((v) => v.key === 'HOSTSTACK_API_KEY');
		expect(row).toBeDefined();
		expect(row?.isSecret).toBe(true);
	});

	test('--no-deploy skips the first deploy', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		devEnvFetch(calls);
		const { restore } = captureIO();
		try {
			await devCommand(['create', '--project', '1', '--no-deploy']);
		} finally {
			restore();
		}
		expect(calls.some((c) => c.url.includes('/deploys'))).toBe(false);
		expect(calls.some((c) => c.url.includes('/volumes'))).toBe(true);
	});

	test('requires --project', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await devCommand(['create']);
			} catch {
				/* expected process.exit */
			}
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('rejects an out-of-range --disk', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await devCommand(['create', '--project', '1', '--disk', '99999']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.includes('--disk'))).toBe(true);
		} finally {
			restore();
		}
	});
});

describe('devCommand help guard', () => {
	// `dev new` takes no required flags, so before the dispatcher guard every
	// flag parsed as absent and `hoststack dev new --help` fell through to the
	// blank-box branch — provisioning a billable box plus a 10 GB volume for
	// someone who only asked what the flags were. The assertion that matters is
	// that NO request is made: a config is saved here on purpose, so the command
	// is fully able to create one and must still decline to.
	for (const argv of [
		['new', '--help'],
		['new', '-h'],
		['new', 'help'],
		['create', '--help'],
		['delete', '-h'],
		// Greedy on purpose: better to print usage than to create a box whose
		// name is literally "--help".
		['new', '--name', '--help'],
	]) {
		test(`\`dev ${argv.join(' ')}\` prints usage and makes no request`, async () => {
			saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
			const calls: { url: string; method?: string }[] = [];
			installFetch((url, init) => {
				calls.push({ url, method: init?.method });
				return new Response('{}', { status: 200 });
			});
			const { cap, restore } = captureIO();
			try {
				try {
					await devCommand(argv);
				} catch {
					/* expected process.exit */
				}
				expect(calls).toEqual([]);
				expect(cap.exitCode).toBe(0);
				expect(cap.out.some((l) => l.includes('Usage:'))).toBe(true);
			} finally {
				restore();
			}
		});
	}
});

describe('devCommand delete (roadmap #7: svc_ dev-box resolution)', () => {
	test('resolves a dev-box svc_ id via the /api/dev-environments fallback', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string }[] = [];
		installFetch((url, init) => {
			calls.push({ url, method: init?.method });
			// The regular service list FILTERS dev boxes out — so the dev box's
			// svc_ id is absent here. Before #7 this caused "not found".
			if (url.endsWith('/api/services/42')) {
				return new Response(JSON.stringify({ services: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			// The SDK's fallback hits the dev-environments list, where the box lives.
			if (url.endsWith('/api/dev-environments/42')) {
				return new Response(
					JSON.stringify({ environments: [{ id: 77, publicId: 'svc_devbox' }] }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			// The delete call, addressed by the resolved NUMERIC id.
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await devCommand(['delete', 'svc_devbox']);
		} finally {
			restore();
		}
		// The fallback was consulted, and the DELETE used the resolved id (77).
		expect(calls.some((c) => c.url.endsWith('/api/dev-environments/42'))).toBe(true);
		const del = calls.find((c) => c.method === 'DELETE');
		expect(del?.url).toBe('https://hoststack.dev/api/services/42/77/dev-environment');
	});
});

describe('machinesCommand', () => {
	const MACHINES = [
		{
			id: 12,
			hostname: 'byo-t42-desktop',
			name: 'desktop',
			status: 'active',
			enrolled: true,
			totalMemoryMb: 32768,
			totalCpuCores: 16,
			lastHeartbeatAt: '2026-08-13T20:00:00.000Z',
			createdAt: '2026-08-01T00:00:00.000Z',
			agentBuild: 'current',
			agentVersion: 'abc1234',
			targetAgentVersion: 'abc1234',
			agentUpdateStuck: false,
			workloads: { devBoxes: 1, services: 2, databases: 0 },
		},
		{
			id: 13,
			hostname: 'byo-t42-attic',
			name: 'attic',
			status: 'active',
			enrolled: true,
			totalMemoryMb: null,
			totalCpuCores: null,
			lastHeartbeatAt: null,
			createdAt: '2026-08-02T00:00:00.000Z',
			agentBuild: 'from-source',
			agentVersion: 'dev',
			targetAgentVersion: 'abc1234',
			agentUpdateStuck: false,
			workloads: { devBoxes: 0, services: 0, databases: 0 },
		},
	];

	function machinesFetch(calls: { url: string; method?: string; body?: string }[]) {
		installFetch((url, init) => {
			calls.push({ url, method: init?.method, body: init?.body as string | undefined });
			if (init?.method === 'DELETE') {
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (init?.method === 'POST') {
				return new Response(
					JSON.stringify({
						pairingToken: 'pair_secret',
						expiresAt: '2026-08-14T00:00:00.000Z',
						installCommand: 'curl -fsSL https://hoststack.dev/install.sh | sudo bash',
						installCommandPowerShell: 'irm https://hoststack.dev/install.ps1 | iex',
					}),
					{ status: 201, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response(JSON.stringify({ machines: MACHINES }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
	}

	test('list names every machine and what it is carrying', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string }[] = [];
		machinesFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await machinesCommand(['list']);
		} finally {
			restore();
		}
		const out = cap.out.join('\n');
		expect(out).toContain('desktop');
		expect(out).toContain('attic');
		expect(out).toContain('2 services');
		// A source-built agent is a build we never replace and cannot identify,
		// so "attic" is connected but NOT reported as plain online — that
		// reading is what let a machine run for months without a shipped fix.
		expect(out).not.toMatch(/attic.*online/);
		expect(out).toContain('from source');
	});

	test('add prints the installer and says when its token dies', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		machinesFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await machinesCommand(['add', 'desktop']);
		} finally {
			restore();
		}
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.url).toContain('/api/machines/42');
		expect(JSON.parse(post?.body ?? '{}')).toEqual({ name: 'desktop' });
		const out = cap.out.join('\n');
		expect(out).toContain('install.sh');
		expect(out).toContain('expires');
	});

	// Removal is a control-plane act: the agent stays installed on the machine
	// and keeps dialling in with a secret nobody recognises any more. Printing
	// the cleanup is the difference between an unenrolled machine and a tidy one.
	test('remove unenrols by name and says how to clean up the machine', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		machinesFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await machinesCommand(['remove', 'desktop']);
		} finally {
			restore();
		}
		const del = calls.find((c) => c.method === 'DELETE');
		expect(del?.url).toBe('https://hoststack.dev/api/machines/42/12');
		expect(cap.out.join('\n')).toContain('docker rm -f hoststack-agent');
	});
});

describe('--machine placement flag', () => {
	function placementFetch(
		calls: { url: string; method?: string; body?: string }[],
		machines: unknown[],
	) {
		installFetch((url, init) => {
			calls.push({ url, method: init?.method, body: init?.body as string | undefined });
			if (url.includes('/api/machines/')) {
				return new Response(JSON.stringify({ machines }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('/api/projects/')) {
				return new Response(JSON.stringify({ projects: [{ id: 1, publicId: 'prj_a' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response(
				JSON.stringify({
					service: { id: 5, publicId: 'svc_a', name: 'api', type: 'web_service' },
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
	}

	const desktop = {
		id: 12,
		hostname: 'byo-t42-desktop',
		name: 'desktop',
		status: 'active',
		enrolled: true,
		totalMemoryMb: null,
		totalCpuCores: null,
		lastHeartbeatAt: null,
		createdAt: '2026-08-01T00:00:00.000Z',
		agentBuild: 'current',
		agentVersion: 'abc1234',
		targetAgentVersion: 'abc1234',
		agentUpdateStuck: false,
		workloads: { devBoxes: 0, services: 0, databases: 0 },
	};

	test('resolves a machine NAME to the numeric id the API pins on', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		placementFetch(calls, [desktop]);
		const { restore } = captureIO();
		try {
			await servicesCommand([
				'create',
				'--name',
				'api',
				'--type',
				'web',
				'--project',
				'1',
				'--machine',
				'desktop',
			]);
		} finally {
			restore();
		}
		const create = calls.find((c) => c.method === 'POST');
		const body = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
		expect(body.machineId).toBe(12);
	});

	test('an unknown machine name creates NOTHING and lists the real ones', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		placementFetch(calls, [desktop]);
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand([
					'create',
					'--name',
					'api',
					'--type',
					'web',
					'--project',
					'1',
					'--machine',
					'laptop',
				]);
			} catch {
				/* expected process.exit */
			}
			// The whole point of resolving before the spinner: a typo must not
			// leave a billable service behind on HostStack compute.
			expect(calls.some((c) => c.method === 'POST')).toBe(false);
			expect(cap.err.join('\n')).toContain('desktop');
		} finally {
			restore();
		}
	});

	test('omitting --machine sends no machineId at all', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: { url: string; method?: string; body?: string }[] = [];
		placementFetch(calls, [desktop]);
		const { restore } = captureIO();
		try {
			await servicesCommand(['create', '--name', 'api', '--type', 'web', '--project', '1']);
		} finally {
			restore();
		}
		const create = calls.find((c) => c.method === 'POST');
		const body = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
		expect('machineId' in body).toBe(false);
		// And no machines request either — the default path must not pay for a
		// lookup it does not use.
		expect(calls.some((c) => c.url.includes('/api/machines/'))).toBe(false);
	});
});
