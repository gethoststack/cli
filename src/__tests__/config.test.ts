import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The config module resolves the user home at import time via homedir(), so
// CONFIG_DIR/CONFIG_FILE are frozen at first import. We set $HOME to a unique
// tmp dir BEFORE importing — every function in the module then points to that
// directory for the rest of the suite. Tests coordinate around that single
// location by restamping the JSON file between assertions.
const tmp = mkdtempSync(join(tmpdir(), 'hoststack-cli-config-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
delete process.env.HOSTSTACK_API_KEY;
delete process.env.HOSTSTACK_API_URL;
delete process.env.HOSTSTACK_TEAM_ID;
mkdirSync(join(tmp, '.hoststack'), { recursive: true });

import {
	getApiKey,
	getApiUrl,
	getTeamId,
	loadConfig,
	saveConfig,
} from '../lib/config.ts';

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;
});

describe('CLI config', () => {
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
		expect(getApiUrl()).toBe('http://localhost:3002');
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
