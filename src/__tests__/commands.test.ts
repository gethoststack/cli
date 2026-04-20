import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Seed $HOME before importing anything that resolves config paths.
const tmp = mkdtempSync(join(tmpdir(), 'hoststack-cli-cmd-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
delete process.env.HOSTSTACK_API_KEY;
delete process.env.HOSTSTACK_API_URL;
delete process.env.HOSTSTACK_TEAM_ID;
mkdirSync(join(tmp, '.hoststack'), { recursive: true });

import { initCommand } from '../commands/init.ts';
import { loginCommand } from '../commands/login.ts';
import { projectsCommand } from '../commands/projects.ts';
import { servicesCommand } from '../commands/services.ts';
import { validateCommand } from '../commands/validate.ts';
import { whoamiCommand } from '../commands/whoami.ts';
import { saveConfig } from '../lib/config.ts';

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
	fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
		((url: string, init?: RequestInit) => Promise.resolve(fn(url, init))) as unknown as typeof fetch,
	);
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
		writeFileSync(
			join(workdir, 'hoststack.yaml'),
			'services:\n  web:\n    type: bogus_type\n',
		);
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
		writeFileSync(
			join(workdir, 'hoststack.yaml'),
			'databases:\n  main:\n    version: "16"\n',
		);
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
					JSON.stringify({ projects: [{ id: 1, publicId: 'prj_x', name: 'X', region: 'eu', createdAt: '2026-01-01' }] }),
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

	test('scale rejects non-numeric instance count', async () => {
		saveConfig({ apiKey: 'hs_test_x', teamId: 42 });
		const { cap, restore } = captureIO();
		try {
			try {
				await servicesCommand(['scale', 'svc_1', 'not-a-number']);
			} catch {
				/* expected */
			}
			expect(cap.exitCode).toBe(1);
			expect(cap.err.some((l) => l.toLowerCase().includes('non-negative integer'))).toBe(true);
		} finally {
			restore();
		}
	});

	test('scale rejects negative instance count', async () => {
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
