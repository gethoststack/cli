import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
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
const tmp = mkdtempSync(join(tmpdir(), 'hoststack-cli-api-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
delete process.env.HOSTSTACK_API_KEY;
delete process.env.HOSTSTACK_API_URL;
mkdirSync(join(tmp, '.hoststack'), { recursive: true });

import { apiFetch } from '../lib/api.ts';
import { saveConfig } from '../lib/config.ts';

// Re-pointed before EVERY test, so neither import hoisting nor a sibling
// file's cleanup can leave a test reading or writing the real
// `~/.hoststack`.
beforeEach(() => {
	process.env.HOME = tmp;
	delete process.env.HOSTSTACK_API_KEY;
	delete process.env.HOSTSTACK_API_URL;
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;
});

const globalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;

afterEach(() => {
	if (fetchSpy) {
		fetchSpy.mockRestore();
		fetchSpy = null;
	}
	globalThis.fetch = globalFetch;
});

function installFetch(fn: (url: string, init?: RequestInit) => Response) {
	fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) =>
		Promise.resolve(fn(url, init))) as unknown as typeof fetch);
}

describe('apiFetch', () => {
	test('throws a friendly "not authenticated" error when no apiKey is configured', async () => {
		saveConfig({});
		delete process.env.HOSTSTACK_API_KEY;
		let err: Error | null = null;
		try {
			await apiFetch('/anything');
		} catch (e: unknown) {
			err = e as Error;
		}
		expect(err?.message).toMatch(/Not authenticated/);
	});

	test('attaches Bearer token and a versioned CLI User-Agent', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		let capturedInit: RequestInit | null = null;
		installFetch((_url, init) => {
			capturedInit = init ?? null;
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		await apiFetch('/api/projects/1');
		expect(capturedInit).not.toBeNull();
		const headers = (capturedInit as unknown as { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toBe('Bearer hs_test_abc');
		// CLI HTTP now flows through the SDK, which identifies as the CLI.
		expect(headers['User-Agent']).toMatch(/^hoststack-cli\//);
	});

	test('sets JSON content-type only when a body is sent', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		let getInit: RequestInit | null = null;
		let postInit: RequestInit | null = null;
		installFetch((url, init) => {
			if ((init?.method ?? 'GET') === 'GET') getInit = init ?? null;
			else postInit = init ?? null;
			void url;
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		await apiFetch('/api/projects/1');
		await apiFetch('/api/projects/1', { method: 'POST', body: JSON.stringify({ a: 1 }) });
		const getHeaders = (getInit as unknown as { headers: Record<string, string> }).headers;
		const postHeaders = (postInit as unknown as { headers: Record<string, string> }).headers;
		// GET carries no body → no Content-Type; POST with a JSON body sets it.
		expect(getHeaders['Content-Type']).toBeUndefined();
		expect(postHeaders['Content-Type']).toBe('application/json');
	});

	test('surfaces the server error message on non-ok', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		installFetch(
			() =>
				new Response(JSON.stringify({ error: 'forbidden' }), {
					status: 403,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		let err: Error | null = null;
		try {
			await apiFetch('/api/projects/1');
		} catch (e: unknown) {
			err = e as Error;
		}
		expect(err?.message).toBe('forbidden');
	});

	test('falls back to HTTP status when JSON body has no error field', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		installFetch(
			() =>
				new Response(JSON.stringify({ somethingElse: true }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		let err: Error | null = null;
		try {
			await apiFetch('/api/projects/1');
		} catch (e: unknown) {
			err = e as Error;
		}
		expect(err?.message).toBe('HTTP 502');
	});

	test('surfaces a generic error message when the body is not JSON', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		installFetch(() => new Response('not-json', { status: 500 }));
		let err: Error | null = null;
		try {
			await apiFetch('/api/projects/1');
		} catch (e: unknown) {
			err = e as Error;
		}
		// The SDK falls back to 'Unknown error' when the error body isn't JSON.
		expect(err?.message).toBe('Unknown error');
	});

	test('parses JSON on success and returns the body', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		installFetch(
			() =>
				new Response(JSON.stringify({ projects: [{ id: 'prj_1' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		const data = await apiFetch<{ projects: { id: string }[] }>('/api/projects/1');
		expect(data.projects[0]!.id).toBe('prj_1');
	});

	test('forwards the request method and serializes the body via the SDK', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		let capturedInit: RequestInit | null = null;
		installFetch((_url, init) => {
			capturedInit = init ?? null;
			return new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		await apiFetch('/x', { method: 'DELETE' });
		expect((capturedInit as unknown as { method: string }).method).toBe('DELETE');
		const headers = (capturedInit as unknown as { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toMatch(/^Bearer /);
	});
});
