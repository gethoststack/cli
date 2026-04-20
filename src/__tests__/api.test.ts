import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Seed env BEFORE importing the config-bound modules (same trick as config.test).
const tmp = mkdtempSync(join(tmpdir(), 'hoststack-cli-api-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
delete process.env.HOSTSTACK_API_KEY;
delete process.env.HOSTSTACK_API_URL;
mkdirSync(join(tmp, '.hoststack'), { recursive: true });

import { apiFetch } from '../lib/api.ts';
import { saveConfig } from '../lib/config.ts';

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

	test('attaches Bearer token and application/json content type', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		let capturedInit: RequestInit | null = null;
		installFetch((_url, init) => {
			capturedInit = init ?? null;
			return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
		});
		await apiFetch('/api/projects/1');
		expect(capturedInit).not.toBeNull();
		const headers = (capturedInit as unknown as { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toBe('Bearer hs_test_abc');
		expect(headers['Content-Type']).toBe('application/json');
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

	test('surfaces the generic "Request failed" when body is not JSON', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		installFetch(() => new Response('not-json', { status: 500 }));
		let err: Error | null = null;
		try {
			await apiFetch('/api/projects/1');
		} catch (e: unknown) {
			err = e as Error;
		}
		expect(err?.message).toBe('Request failed');
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

	test('merges custom headers with the default ones', async () => {
		saveConfig({ apiKey: 'hs_test_abc' });
		let capturedInit: RequestInit | null = null;
		installFetch((_url, init) => {
			capturedInit = init ?? null;
			return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
		});
		await apiFetch('/x', { headers: { 'X-Custom': 'yes' } });
		const headers = (capturedInit as unknown as { headers: Record<string, string> }).headers;
		expect(headers['X-Custom']).toBe('yes');
		expect(headers.Authorization).toMatch(/^Bearer /);
	});
});
