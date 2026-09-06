import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
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
const tmp = mkdtempSync(join(tmpdir(), 'hoststack-cli-config-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
delete process.env.HOSTSTACK_API_KEY;
delete process.env.HOSTSTACK_API_URL;
delete process.env.HOSTSTACK_TEAM_ID;
mkdirSync(join(tmp, '.hoststack'), { recursive: true });

import { getApiKey, getApiUrl, getTeamId, loadConfig, saveConfig } from '../lib/config.ts';

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

describe('CLI config', () => {
	// The regression this file exists to hold. `loadConfig`/`saveConfig` used a
	// pair of module-level constants baked from `homedir()`, so the path was
	// frozen at first import and could not be pointed anywhere — which meant
	// this whole suite was reading and writing the developer's real
	// `~/.hoststack/config.json`. It left the fixture key `hs_test_x` in it and
	// raced the other test shards, which is how the deploy gate went flaky.
	//
	// Two independent homes, exercised in both directions, so a re-freeze fails
	// here rather than in whichever unrelated assertion loses the race next time.
	test('reads and writes the config under the CURRENT $HOME, not the one at import', () => {
		const other = mkdtempSync(join(tmpdir(), 'hoststack-cli-home-'));
		try {
			saveConfig({ apiKey: 'in-the-first-home' });

			process.env.HOME = other;
			expect(loadConfig()).toEqual({});
			saveConfig({ apiKey: 'in-the-second-home' });
			expect(loadConfig()).toEqual({ apiKey: 'in-the-second-home' });

			process.env.HOME = tmp;
			expect(loadConfig()).toEqual({ apiKey: 'in-the-first-home' });
		} finally {
			process.env.HOME = tmp;
			rmSync(other, { recursive: true, force: true });
		}
	});

	test('saveConfig + loadConfig roundtrip', () => {
		saveConfig({ apiKey: 'hs_live_x', teamId: 42 });
		expect(loadConfig()).toEqual({ apiKey: 'hs_live_x', teamId: 42 });
	});

	test('getApiKey prefers the env var over the saved config', () => {
		saveConfig({ apiKey: 'from-file' });
		process.env.HOSTSTACK_API_KEY = 'from-env';
		expect(getApiKey()).toBe('from-env');
		delete process.env.HOSTSTACK_API_KEY;
	});

	test('getApiKey falls back to the config file when env is unset', () => {
		saveConfig({ apiKey: 'from-file' });
		expect(getApiKey()).toBe('from-file');
	});

	test('getApiUrl prefers env, then file, then default', () => {
		saveConfig({});
		expect(getApiUrl()).toBe('https://hoststack.dev');
		saveConfig({ apiUrl: 'https://from-file.io' });
		expect(getApiUrl()).toBe('https://from-file.io');
		process.env.HOSTSTACK_API_URL = 'https://from-env.io';
		expect(getApiUrl()).toBe('https://from-env.io');
		delete process.env.HOSTSTACK_API_URL;
	});

	test('getTeamId parses the env var as an integer', () => {
		process.env.HOSTSTACK_TEAM_ID = '7';
		expect(getTeamId()).toBe(7);
		delete process.env.HOSTSTACK_TEAM_ID;
	});

	test('getTeamId falls back to the config file', () => {
		saveConfig({ teamId: 99 });
		expect(getTeamId()).toBe(99);
	});
});
