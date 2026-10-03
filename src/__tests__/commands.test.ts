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

import { activityCommand } from '../commands/activity.ts';
import { alertsCommand } from '../commands/alerts.ts';
import { dbCommand } from '../commands/db.ts';
import { deployCommand } from '../commands/deploy.ts';
import { devCommand } from '../commands/dev.ts';
import { domainsCommand } from '../commands/domains.ts';
import { envCommand } from '../commands/env.ts';
import { infraCommand } from '../commands/infra.ts';
import { initCommand } from '../commands/init.ts';
import { loginCommand } from '../commands/login.ts';
import { logsCommand, normalizeSince } from '../commands/logs.ts';
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

	/**
	 * `--repo owner/name` is sent as `githubRepo` for the API to resolve.
	 *
	 * It used to be resolved here first, by GETting /api/github/:teamId/repos —
	 * typed as a bare array against an endpoint that answers `{ repos: [...] }`,
	 * so every `--repo` create died on `repos.find is not a function`. Nothing
	 * covered it, which is most of why it survived. This asserts BOTH halves:
	 * the field goes out, and no repo lookup happens on the way.
	 */
	test('create sends --repo as githubRepo, without a client-side lookup', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const seen: { url: string; body: unknown }[] = [];
		installFetch((url, init) => {
			seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			return new Response(JSON.stringify({ service: { id: 1, publicId: 'svc_abc' } }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await servicesCommand([
				'create',
				'--name',
				'sten',
				'--type',
				'web_service',
				'--project',
				'7',
				'--repo',
				'miccidk/stenshoppen',
			]);
		} finally {
			restore();
		}

		expect(seen.map((r) => r.url).some((u) => u.includes('/api/github/'))).toBe(false);
		const post = seen.find((r) => r.url.includes('/api/services/'));
		expect(post?.body).toMatchObject({ githubRepo: 'miccidk/stenshoppen', projectId: 7 });
		expect(post?.body).not.toHaveProperty('githubRepoId');
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

// ── alertsCommand ────────────────────────────────────────────────────────
describe('alertsCommand', () => {
	const aggregated = {
		alerts: [
			{
				action: 'deploy.failed_consecutive',
				resourceType: 'service',
				resourceId: 31,
				severity: 'critical',
				count: 3,
				firstFiredAt: '2026-01-01T09:00:00.000Z',
				lastFiredAt: '2026-01-01T09:20:00.000Z',
				lastResolvedAt: null,
				active: true,
				lastMetadata: { commitHash: 'abc1234' },
			},
		],
		aggregated: true,
		activeOnly: true,
	};

	test('list defaults to the narrow view — no aggregate=0, no active=0', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			return new Response(JSON.stringify(aggregated), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await alertsCommand([]);
			expect(urls[0]).toContain('/api/alerts/42');
			// Both flags default to "1" server-side. Shipping them explicitly
			// would be noise; shipping the wrong one silently widens triage.
			expect(urls[0]).not.toContain('aggregate=');
			expect(urls[0]).not.toContain('active=');
			expect(cap.out.join('\n')).toContain('deploy.failed_consecutive');
			expect(cap.out.join('\n')).toContain('3x');
		} finally {
			restore();
		}
	});

	test('--raw and --all opt out of both defaults', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			return new Response(
				JSON.stringify({ alerts: [], aggregated: false, activeOnly: false }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await alertsCommand(['list', '--raw', '--all', '--since', '-6h', '--limit', '5']);
			expect(urls[0]).toContain('aggregate=0');
			expect(urls[0]).toContain('active=0');
			expect(urls[0]).toContain('since=-6h');
			expect(urls[0]).toContain('limit=5');
		} finally {
			restore();
		}
	});

	test('a bare flag is treated as list, not an unknown subcommand', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			return new Response(JSON.stringify(aggregated), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await alertsCommand(['--since', '-1h']);
			expect(urls[0]).toContain('since=-1h');
			expect(cap.exitCode).toBeNull();
		} finally {
			restore();
		}
	});

	test('resolve posts the whole four-field identity, nulls included', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		installFetch((url, init) => {
			calls.push({
				url,
				method: (init?.method ?? 'GET').toUpperCase(),
				body: init?.body as string | undefined,
			});
			return new Response(JSON.stringify({ resolved: 2 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await alertsCommand([
				'resolve',
				'--action',
				'service.acme_cert_failed',
				'--severity',
				'error',
			]);
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.url).toContain('/api/alerts/42/resolve');
			// resourceType/resourceId must travel as explicit nulls: a
			// team-wide alert genuinely has neither, and the endpoint matches
			// them with IS NOT DISTINCT FROM.
			expect(JSON.parse(post!.body as string)).toEqual({
				action: 'service.acme_cert_failed',
				severity: 'error',
				resourceType: null,
				resourceId: null,
			});
		} finally {
			restore();
		}
	});

	test('resolve refuses a severity the endpoint would not group on', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			try {
				await alertsCommand(['resolve', '--action', 'x', '--severity', 'bad']);
			} catch {
				/* expected process.exit */
			}
			expect(called).toBe(false);
			expect(cap.err.join('\n')).toContain('Unknown severity');
		} finally {
			restore();
		}
	});

	test('channels add rejects an invented event before the request', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			try {
				await alertsCommand([
					'channels',
					'add',
					'--type',
					'slack',
					'--name',
					'ops',
					'--url',
					'https://hooks.slack.test/x',
					'--events',
					'deploy.failed,deploy.exploded',
				]);
			} catch {
				/* expected process.exit */
			}
			expect(called).toBe(false);
			expect(cap.err.join('\n')).toContain('deploy.exploded');
		} finally {
			restore();
		}
	});

	test('channels add --events all expands to the whole list', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let sent: Record<string, unknown> = {};
		installFetch((_url, init) => {
			sent = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					channel: {
						id: 7,
						type: 'slack',
						name: 'ops',
						events: sent.events,
						active: true,
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { restore } = captureIO();
		try {
			await alertsCommand([
				'channels',
				'add',
				'--type',
				'slack',
				'--name',
				'ops',
				'--url',
				'https://hooks.slack.test/x',
				'--events',
				'all',
			]);
			expect(Array.isArray(sent.events)).toBe(true);
			expect((sent.events as string[]).length).toBeGreaterThan(40);
			expect(sent.webhookUrl).toBe('https://hooks.slack.test/x');
		} finally {
			restore();
		}
	});

	test('channels test reports the BODY outcome, not the 200', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(JSON.stringify({ success: false, error: 'slack said 404' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		const { cap, restore } = captureIO();
		try {
			try {
				await alertsCommand(['channels', 'test', '7']);
			} catch {
				/* expected process.exit */
			}
			// A 200 here means "dispatch attempted". Printing "sent" on it is
			// the same lie `domains verify` used to tell.
			expect(cap.exitCode).toBe(1);
			expect(cap.out.join('\n')).toContain('slack said 404');
		} finally {
			restore();
		}
	});
});

// ── activityCommand ──────────────────────────────────────────────────────
describe('activityCommand', () => {
	const page = {
		data: [
			{
				id: 1,
				action: 'env_var.deleted',
				severity: 'info',
				resourceType: 'service',
				resourceId: 48,
				metadata: {},
				ipAddress: '203.0.113.9',
				userId: 2,
				userName: 'Ada',
				userEmail: 'ada@example.test',
				createdAt: '2026-01-01T09:00:00.000Z',
				resolvedAt: null,
			},
		],
		page: 1,
		perPage: 25,
		total: 60,
		totalPages: 3,
	};

	test('maps its flags onto the API query names', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			return new Response(JSON.stringify(page), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await activityCommand([
				'--type',
				'deploy',
				'--user',
				'2',
				'--since',
				'-2h',
				'--per-page',
				'10',
			]);
			const url = urls[0] ?? '';
			expect(url).toContain('resourceType=deploy');
			expect(url).toContain('userId=2');
			expect(url).toContain('since=-2h');
			expect(url).toContain('perPage=10');
			// Paging stated, not implied: page 1 of 3 must be visible.
			expect(cap.out.join('\n')).toContain('Page 1 of 3');
		} finally {
			restore();
		}
	});

	test('a non-numeric --user is refused here, not silently matched there', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			try {
				await activityCommand(['--user', 'ada']);
			} catch {
				/* expected process.exit */
			}
			expect(called).toBe(false);
			expect(cap.err.join('\n')).toContain('--user');
		} finally {
			restore();
		}
	});

	test('a platform-actor row does not render as missing data', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						...page,
						data: [{ ...page.data[0], userId: null, userName: null, userEmail: null }],
						totalPages: 1,
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await activityCommand([]);
			expect(cap.out.join('\n')).toContain('platform');
		} finally {
			restore();
		}
	});
});

// ── deploy diagnose / promote ────────────────────────────────────────────
describe('deployCommand diagnose', () => {
	function deployRow(status: string) {
		return {
			deploy: {
				id: 1,
				publicId: 'dpl_x',
				status,
				trigger: 'manual',
				commitHash: 'abc1234567',
				commitMessage: 'do the thing',
				createdAt: '2026-01-01T09:00:00.000Z',
				startedAt: '2026-01-01T09:00:05.000Z',
			},
		};
	}

	test('a build-time failure never fetches runtime logs', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			if (url.includes('/logs'))
				return new Response(JSON.stringify({ logs: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			return new Response(JSON.stringify(deployRow('building')), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await deployCommand(['diagnose', 'svc_1', 'dpl_x']);
			// The previous release's output is what that request would have
			// returned, and it reads exactly like the new one working.
			expect(urls.some((u) => u.includes('runtime-logs'))).toBe(false);
			expect(cap.out.join('\n')).toContain('never started a container');
		} finally {
			restore();
		}
	});

	test('a deploy that ran pulls the runtime tail bounded by its own start', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			if (url.includes('runtime-logs'))
				return new Response(JSON.stringify({ logs: [{ message: 'listening on 3000' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			if (url.includes('/logs'))
				return new Response(
					JSON.stringify({ logs: [{ id: 1, level: 'info', message: 'built' }] }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			return new Response(JSON.stringify(deployRow('failed')), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await deployCommand(['diagnose', 'svc_1', 'dpl_x', '--runtime-lines', '5']);
			const runtime = urls.find((u) => u.includes('runtime-logs')) ?? '';
			expect(runtime).toContain('lines=5');
			expect(runtime).toContain('since=2026-01-01T09%3A00%3A05.000Z');
			expect(cap.out.join('\n')).toContain('listening on 3000');
		} finally {
			restore();
		}
	});

	test('--runtime-lines 0 skips the runtime half outright', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			if (url.includes('/logs'))
				return new Response(JSON.stringify({ logs: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			return new Response(JSON.stringify(deployRow('live')), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await deployCommand(['diagnose', 'svc_1', 'dpl_x', '--runtime-lines', '0']);
			expect(urls.some((u) => u.includes('runtime-logs'))).toBe(false);
		} finally {
			restore();
		}
	});

	test('promote resolves an env_… publicId to the numeric id the API wants', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		installFetch((url, init) => {
			calls.push({
				url,
				method: (init?.method ?? 'GET').toUpperCase(),
				body: init?.body as string | undefined,
			});
			if (url.includes('/api/environments/'))
				return new Response(
					JSON.stringify({
						environments: [{ id: 9, publicId: 'env_prod', name: 'prod' }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			if (url.includes('/api/projects/'))
				return new Response(JSON.stringify({ projects: [{ id: 1, publicId: 'prj_a' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			return new Response(
				JSON.stringify({
					deploy: {
						id: 2,
						publicId: 'dpl_new',
						status: 'pending',
						trigger: 'rollback',
						createdAt: '2026-01-01',
					},
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { cap, restore } = captureIO();
		try {
			await deployCommand(['promote', 'svc_1', 'dpl_x', '--to', 'env_prod']);
			const post = calls.find((c) => c.method === 'POST' && c.url.includes('/promote'));
			expect(post).toBeDefined();
			// `environments list` prints publicIds; the route takes a number.
			expect(JSON.parse(post!.body as string)).toEqual({ targetEnvironmentId: 9 });
			// The one thing that bites after a promote, said every time.
			expect(cap.out.join('\n')).toContain('did not come with it');
		} finally {
			restore();
		}
	});
});

// ── db query / restart / update ──────────────────────────────────────────
describe('dbCommand additions', () => {
	test('query posts the sql and names the server cap when truncated', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		installFetch((url, init) => {
			calls.push({
				url,
				method: (init?.method ?? 'GET').toUpperCase(),
				body: init?.body as string | undefined,
			});
			return new Response(
				JSON.stringify({
					columns: ['id'],
					rows: [['1'], ['2']],
					rowCount: 2,
					truncated: true,
					durationMs: 12,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { cap, restore } = captureIO();
		try {
			await dbCommand(['query', 'db_abc', 'SELECT id FROM users']);
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.url).toContain('/api/databases/42/db_abc/query');
			expect(JSON.parse(post!.body as string)).toEqual({ sql: 'SELECT id FROM users' });
			// A capped result looks exactly like a complete one in the data.
			expect(cap.out.join('\n')).toContain('Truncated');
		} finally {
			restore();
		}
	});

	test('update sends only the fields given, and refuses an unknown plan', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ method: string; body?: string }> = [];
		installFetch((_url, init) => {
			calls.push({
				method: (init?.method ?? 'GET').toUpperCase(),
				body: init?.body as string | undefined,
			});
			return new Response(JSON.stringify({ database: { id: 1, name: 'app-db' } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { cap, restore } = captureIO();
		try {
			await dbCommand(['update', 'db_abc', '--disk', '50']);
			const patch = calls.find((c) => c.method === 'PATCH');
			expect(JSON.parse(patch!.body as string)).toEqual({ diskSizeGb: 50 });

			calls.length = 0;
			try {
				await dbCommand(['update', 'db_abc', '--plan', 'enormous']);
			} catch {
				/* expected process.exit */
			}
			expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
			expect(cap.err.join('\n')).toContain('Unknown plan');
		} finally {
			restore();
		}
	});

	test('restart hits the restart route, not suspend+resume', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await dbCommand(['restart', 'db_abc']);
			expect(urls[0]).toContain('/api/databases/42/db_abc/restart');
			expect(urls.some((u) => u.includes('/suspend'))).toBe(false);
		} finally {
			restore();
		}
	});
});

// ── domains update ───────────────────────────────────────────────────────
describe('domainsCommand update', () => {
	const listRow = {
		id: 131,
		publicId: 'dom_x',
		domain: 'example.com',
		status: 'active',
		serviceId: 198,
		isPrimary: false,
		createdAt: '2026-09-11T09:25:03.438Z',
	};

	/** GET returns the team's domains; anything else returns the patched row. */
	function domainFetch(calls: Array<{ url: string; method: string; body?: string }>) {
		installFetch((url, init) => {
			const method = (init?.method ?? 'GET').toUpperCase();
			calls.push({ url, method, body: init?.body as string | undefined });
			if (method === 'GET') {
				return new Response(JSON.stringify({ domains: [listRow] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({ domain: { ...listRow, isPrimary: true } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
	}

	test('--primary resolves the publicId to the numeric id the route needs', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		domainFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await domainsCommand(['update', 'dom_x', '--primary']);
			const patch = calls.find((c) => c.method === 'PATCH');
			// `parseIdParam` on the route rejects a dom_… outright — this used
			// to come back "Invalid domain ID" for the id `domains list` prints.
			expect(patch?.url).toContain('/api/domains/42/131');
			expect(JSON.parse(patch!.body as string)).toEqual({ isPrimary: true });
			expect(cap.out.join('\n')).toContain('uptime check probes');
		} finally {
			restore();
		}
	});

	test('the hostname itself resolves too — it is what people are holding', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		domainFetch(calls);
		const { restore } = captureIO();
		try {
			await domainsCommand(['update', 'example.com', '--primary']);
			expect(calls.find((c) => c.method === 'PATCH')?.url).toContain('/api/domains/42/131');
		} finally {
			restore();
		}
	});

	test('an unknown domain never reaches the route', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		domainFetch(calls);
		const { cap, restore } = captureIO();
		try {
			try {
				await domainsCommand(['update', 'nope.example.com', '--primary']);
			} catch {
				/* expected process.exit */
			}
			expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
			expect(cap.err.join('\n')).toContain('nope.example.com');
		} finally {
			restore();
		}
	});

	test('--no-redirect clears with an explicit null, not an empty string', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		domainFetch(calls);
		const { restore } = captureIO();
		try {
			await domainsCommand(['update', 'dom_x', '--no-redirect']);
			const patch = calls.find((c) => c.method === 'PATCH');
			expect(JSON.parse(patch!.body as string)).toEqual({ redirectTo: null });
		} finally {
			restore();
		}
	});

	test('update with no field to change sends nothing', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			try {
				await domainsCommand(['update', 'dom_x']);
			} catch {
				/* expected process.exit */
			}
			expect(called).toBe(false);
			expect(cap.out.join('\n')).toContain('--primary');
		} finally {
			restore();
		}
	});

	test('list names the silent fallback when a service has no primary', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						domains: [
							{
								id: 118,
								publicId: 'dom_old',
								domain: 'staging.example.com',
								status: 'active',
								serviceId: 198,
								isPrimary: false,
								createdAt: '2026-08-25T10:05:12.864Z',
							},
							{
								id: 131,
								publicId: 'dom_new',
								domain: 'example.com',
								status: 'active',
								serviceId: 198,
								isPrimary: false,
								createdAt: '2026-09-11T09:25:03.438Z',
							},
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const { cap, restore } = captureIO();
		try {
			await domainsCommand(['list']);
			const out = cap.out.join('\n');
			// The fallback is the OLDEST domain — on a renamed host, the alias
			// that redirects. This is what pointed an uptime check at a 301.
			expect(out).toContain('no primary nominated');
			expect(out).toContain('staging.example.com');
			expect(out).toContain('domains update');
			// Neither fixture carries a `verified` boolean, because the route
			// does not return one. Reading it printed "no" for every domain on
			// the team, live ones included; `status` is the real signal.
			expect(out).not.toMatch(/\bno\b\s*\|/);
		} finally {
			restore();
		}
	});
});

// ── envCommand import ────────────────────────────────────────────────────
describe('envCommand import', () => {
	const SECRET = '$2y$10$abcdefghijklmnopqrstuv.WXYZ0123456789abcdefghijklmnopq';

	function writeEnvFile(contents: string): string {
		const path = join(tmp, 'prod.env');
		writeFileSync(path, contents);
		return path;
	}

	test('a dry run sends the file unapplied and prints keys and refusals, never a value', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const file = writeEnvFile(`GOOD='${SECRET}'\nBAD=${SECRET}\n`);
		let sent: Record<string, unknown> | null = null;
		installFetch((_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					dryRun: true,
					applied: false,
					mode: 'merge',
					refusals: [{ line: 2, reason: 'BAD: the unquoted value contains "$"' }],
					warnings: [],
					plan: [{ key: 'GOOD', action: 'add' }],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { cap, restore } = captureIO();
		try {
			await envCommand(['import', 'svc_mail', file]).catch(() => {});
			expect(sent).toMatchObject({
				dryRun: true,
				mode: 'merge',
				target: 'runtime',
				isSecret: true,
			});
			const printed = [...cap.out, ...cap.err].join('\n');
			expect(printed).toContain('GOOD');
			expect(printed).toContain('line 2');
			expect(printed).not.toContain('abcdefghijklmnop');
			expect(cap.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	test('--apply --replace writes and reports the round trip', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const file = writeEnvFile(`GOOD='${SECRET}'\n`);
		let sent: Record<string, unknown> | null = null;
		installFetch((_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					dryRun: false,
					applied: true,
					mode: 'replace',
					refusals: [],
					warnings: [],
					plan: [{ key: 'GOOD', action: 'add' }],
					roundTrip: { verified: 1, mismatched: [] },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const { cap, restore } = captureIO();
		try {
			await envCommand(['import', 'svc_mail', file, '--apply', '--replace']);
			expect(sent).toMatchObject({ dryRun: false, mode: 'replace' });
			expect(cap.out.join('\n')).toContain('byte for byte');
			expect(cap.exitCode).toBeNull();
		} finally {
			restore();
		}
	});

	test('a file that is not valid UTF-8 is an error, and nothing is sent', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const path = join(tmp, 'latin1.env');
		// "SMTP_BANNER='Grüße'" in Latin-1: 0xFC and 0xDF are not UTF-8.
		writeFileSync(
			path,
			Buffer.concat([
				Buffer.from("SMTP_BANNER='Gr"),
				Buffer.from([0xfc, 0xdf]),
				Buffer.from("e'\n"),
			]),
		);
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			await envCommand(['import', 'svc_mail', path]).catch(() => {});
			expect(cap.exitCode).toBe(1);
			expect(cap.err.join('\n')).toContain('not valid UTF-8');
			expect(called).toBe(false);
		} finally {
			restore();
		}
	});

	test('an unreadable file is an error, and nothing is sent', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		let called = false;
		installFetch(() => {
			called = true;
			return new Response('{}', { status: 200 });
		});
		const { cap, restore } = captureIO();
		try {
			await envCommand(['import', 'svc_mail', join(tmp, 'missing.env')]).catch(() => {});
			expect(cap.exitCode).toBe(1);
			expect(called).toBe(false);
		} finally {
			restore();
		}
	});
});

// ── infraCommand ─────────────────────────────────────────────────────────
// `hoststack infra` runs a cutover's operator steps with a short-lived infra operator token. The
// two things that matter: it never borrows the saved API key, and what it sends is exactly what
// was asked for — a policy file byte for byte, and no full rollout unless the flag says so.
describe('infraCommand', () => {
	const TOKEN = `hsiot_${'a'.repeat(64)}`;
	type Call = { url: string; method?: string; body?: string; auth?: string };

	const PLAN_TOKEN = `hsrpt_${'b'.repeat(64)}`;

	// Before as well as after: a dev box is SEEDED with a real plan token in its
	// environment, so without this the first "no token" test ran with one and
	// failed — and so did the deploy gate on that box.
	const savedTokens = {
		infra: process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN,
		plan: process.env.HOSTSTACK_RELEASE_PLAN_TOKEN,
	};
	beforeEach(() => {
		delete process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN;
		delete process.env.HOSTSTACK_RELEASE_PLAN_TOKEN;
	});
	afterEach(() => {
		delete process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN;
		delete process.env.HOSTSTACK_RELEASE_PLAN_TOKEN;
	});
	afterAll(() => {
		if (savedTokens.infra !== undefined)
			process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = savedTokens.infra;
		if (savedTokens.plan !== undefined)
			process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = savedTokens.plan;
	});

	function infraFetch(calls: Call[]) {
		installFetch((url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push({
				url,
				method: init?.method,
				body: init?.body as string | undefined,
				auth: headers.Authorization,
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
	}

	test('refuses to run without an infra operator token, and never falls back to the API key', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const calls: Call[] = [];
		infraFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await infraCommand(['release', 'get', 'rel_x']);
		} catch {
			// process.exit is stubbed to throw.
		} finally {
			restore();
		}
		expect(cap.exitCode).toBe(1);
		expect(cap.err.join('\n')).toContain('HOSTSTACK_INFRA_OPERATOR_TOKEN');
		expect(calls).toHaveLength(0);
	});

	test('plans a release with the token as the bearer, and no full rollout unless asked', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['release', 'plan', '15', '--commit', 'b'.repeat(40)]);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toEndWith('/api/admin/projects/15/releases');
		expect(calls[0]!.method).toBe('POST');
		expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
		expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
			commitSha: 'b'.repeat(40),
			allowFullRollout: false,
		});
	});

	// Task 450: the id had to come from somewhere, and until this there was no command that would
	// tell you one — not here and not in the dashboard.
	test("lists a project's releases with either token", async () => {
		process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = PLAN_TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['release', 'list', '15']);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toEndWith('/api/admin/projects/15/releases');
		expect(calls[0]!.method ?? 'GET').toBe('GET');
		expect(calls[0]!.auth).toBe(`Bearer ${PLAN_TOKEN}`);
	});

	// Task 447: the CLI minted plan tokens and had no code path for one, so the supported command
	// worked with exactly the credential that should not be on a dev box and not with the one that
	// should. These four are the whole contract: which commands take a plan token, which do not,
	// what the refusal says, and which token wins when both are set.
	test('runs a release read and a start with a plan token alone', async () => {
		process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = PLAN_TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['release', 'get', 'rel_x']);
			// Whether THIS token may start is a fact about the token record, which only the API can
			// read — so the CLI sends it rather than inventing a client-side rule.
			await infraCommand(['release', 'start', 'rel_x']);
		} finally {
			restore();
		}
		expect(calls.map((c) => [c.method ?? 'GET', c.url.split('/api')[1], c.auth])).toEqual([
			['GET', '/admin/releases/rel_x', `Bearer ${PLAN_TOKEN}`],
			['POST', '/admin/releases/rel_x/start', `Bearer ${PLAN_TOKEN}`],
		]);
	});

	// Task 451: the token in the environment can be read without using it, and only ever with the
	// plan token — an operator token beside it is not what the question is about.
	test('plan-token whoami asks about the plan token even when an operator token is set', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = PLAN_TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['plan-token', 'whoami']);
		} finally {
			restore();
		}
		expect(calls.map((c) => [c.method ?? 'GET', c.url.split('/api')[1], c.auth])).toEqual([
			['GET', '/admin/release-plan-token', `Bearer ${PLAN_TOKEN}`],
		]);
	});

	test('plan-token --dev-box binds the minted token to a box', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand([
				'plan-token',
				'15',
				'--name',
				'poststack box',
				'--days',
				'30',
				'--can-start',
				'--dev-box',
				'svc_abc123',
			]);
		} finally {
			restore();
		}
		expect(calls[0]!.url).toEndWith('/api/admin/projects/15/release-plan-tokens');
		expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
			name: 'poststack box',
			expiresInDays: 30,
			canStart: true,
			devBox: 'svc_abc123',
		});
	});

	test('refuses an operator-only command to a plan token, naming what the plan token CAN run', async () => {
		process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = PLAN_TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await infraCommand(['release', 'rollback', 'rel_x']);
		} catch {
			// process.exit is stubbed to throw.
		} finally {
			restore();
		}
		expect(cap.exitCode).toBe(1);
		const message = cap.err.join('\n');
		expect(message).toContain('needs an infra operator token');
		expect(message).toContain('release plan');
		expect(message).toContain('--can-start');
		// Never the token itself, or a prefix of it.
		expect(message).not.toContain(PLAN_TOKEN);
		expect(message).not.toContain(PLAN_TOKEN.slice(0, 20));
		expect(calls).toHaveLength(0);
	});

	test('prefers the operator token when both are set, and falls back on a 401', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = PLAN_TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['release', 'get', 'rel_x']);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);

		// An expired operator token with a live plan token beside it should still read.
		const retried: Call[] = [];
		installFetch((url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			retried.push({ url, method: init?.method, auth: headers.Authorization });
			return headers.Authorization === `Bearer ${TOKEN}`
				? new Response(JSON.stringify({ error: 'expired' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					})
				: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
		});
		const second = captureIO();
		try {
			await infraCommand(['release', 'get', 'rel_y']);
		} finally {
			second.restore();
		}
		expect(retried.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${PLAN_TOKEN}`]);
	});

	test('a value of the wrong kind in either variable is named, not sent', async () => {
		process.env.HOSTSTACK_RELEASE_PLAN_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await infraCommand(['release', 'get', 'rel_x']);
		} catch {
			// process.exit is stubbed to throw.
		} finally {
			restore();
		}
		expect(cap.exitCode).toBe(1);
		expect(cap.err.join('\n')).toContain('hsrpt_');
		expect(calls).toHaveLength(0);
	});

	test("reads an infra machine's project network", async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['network', '12458']);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toEndWith('/api/admin/servers/12458/project-network');
		expect(calls[0]!.method ?? 'GET').toBe('GET');
		expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
	});

	test('recreates the project network only when --recreate is given', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['network', '12458', '--recreate']);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toEndWith('/api/admin/servers/12458/project-network/recreate');
		expect(calls[0]!.method).toBe('POST');
	});

	test('sends a machine policy exactly as the file holds it', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const file = join(tmp, 'policy.json');
		const policy = { addresses: ['192.0.2.7'], mountRoots: ['/etc/letsencrypt'] };
		writeFileSync(file, JSON.stringify(policy));
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['policy', '4', '--file', file]);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toEndWith('/api/admin/servers/4/infra-policy');
		expect(calls[0]!.method).toBe('PUT');
		expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual(policy);
	});

	test('refuses a short commit SHA before sending anything', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { cap, restore } = captureIO();
		try {
			await infraCommand(['build', '7', '--commit', 'abc123']);
		} catch {
			// process.exit is stubbed to throw.
		} finally {
			restore();
		}
		expect(cap.exitCode).toBe(1);
		expect(calls).toHaveLength(0);
	});

	test('takes a service out of releases with a DELETE and no body', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand(['release-settings', '237', '--remove']);
		} finally {
			restore();
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toEndWith('/api/admin/services/237/release-settings');
		expect(calls[0]!.method).toBe('DELETE');
		expect(calls[0]!.body).toBeUndefined();
	});

	test('plans a release of named services only when --services is given', async () => {
		process.env.HOSTSTACK_INFRA_OPERATOR_TOKEN = TOKEN;
		const calls: Call[] = [];
		infraFetch(calls);
		const { restore } = captureIO();
		try {
			await infraCommand([
				'release',
				'plan',
				'15',
				'--commit',
				'b'.repeat(40),
				'--services',
				'235, 236',
			]);
		} finally {
			restore();
		}
		expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
			commitSha: 'b'.repeat(40),
			allowFullRollout: false,
			services: [235, 236],
		});
	});
});

describe('logs', () => {
	test('--since 10m reaches the API as -10m, and --level/--stream/--search are passed on', async () => {
		// Both were silently dropped: `10m` is not a form the API parses (it skips
		// what it cannot read, so no time filter applied), and `--level` was
		// never read at all, so `--level error` printed info lines too.
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const urls: string[] = [];
		installFetch((url) => {
			urls.push(url);
			return new Response(JSON.stringify({ logs: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const { restore } = captureIO();
		try {
			await logsCommand([
				'svc_1',
				'--since',
				'10m',
				'--level',
				'error',
				'--stream',
				'stderr',
				'--search',
				'boom',
			]);
		} finally {
			restore();
		}
		const q = new URL(urls[0] ?? '').searchParams;
		expect(q.get('since')).toBe('-10m');
		expect(q.get('level')).toBe('error');
		expect(q.get('stream')).toBe('stderr');
		expect(q.get('search')).toBe('boom');
	});

	test('normalizeSince accepts the documented and API forms, rejects the rest', () => {
		expect(normalizeSince('10m')).toBe('-10m');
		expect(normalizeSince('-1h')).toBe('-1h');
		expect(normalizeSince('2026-10-03T13:00:00Z')).toBe('2026-10-03T13:00:00Z');
		expect(normalizeSince('10 minutes')).toBeUndefined();
		expect(normalizeSince('10')).toBeUndefined();
	});
});
