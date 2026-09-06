import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface HostStackConfig {
	apiKey?: string;
	apiUrl?: string;
	teamId?: number;
}

/**
 * The home directory the config lives under, resolved on every call.
 *
 * Two things here are deliberate and neither is obvious.
 *
 * **`process.env.HOME` first, `homedir()` only as the fallback.** Bun's
 * `homedir()` reads the passwd entry, not the environment — set
 * `process.env.HOME` and call it again and it returns the ORIGINAL path
 * (verified, not assumed). So a module built on `homedir()` alone cannot be
 * pointed anywhere, which makes it untestable by construction. Honouring $HOME
 * is also the POSIX convention every other CLI follows.
 *
 * **Resolved per call rather than frozen in a module constant.** This was a
 * pair of module-level constants, and a module is evaluated once per process.
 * Combined with the point above, the CLI's own test suite — three files that
 * each `mkdtemp` a home and set `process.env.HOME` before their imports — wrote
 * to the DEVELOPER'S REAL `~/.hoststack/config.json`. ESM imports are hoisted
 * above statements, so "set $HOME before importing" never happened; and even
 * where it did, `homedir()` ignored it.
 *
 * Two consequences, both observed rather than theorised:
 *   - `bun run test` logged you out of the CLI. The real config was left
 *     holding the suite's fixture value, `hs_test_x`.
 *   - The deploy gate went flaky. The suite runs eight concurrent shards, all
 *     pointed at that one real file, so a `saveConfig({})` in one process and a
 *     `loginCommand` in another raced — `getApiKey()` returned a key the test
 *     had just cleared, and the "not authenticated" assertion failed with
 *     `Unknown error`. Roughly one gate run in two, never in isolation.
 */
function configHome(): string {
	return process.env.HOME ?? homedir();
}

function configDir(): string {
	return join(configHome(), '.hoststack');
}

function configFile(): string {
	return join(configDir(), 'config.json');
}

export function loadConfig(): HostStackConfig {
	if (!existsSync(configFile())) return {};
	try {
		return JSON.parse(readFileSync(configFile(), 'utf-8')) as HostStackConfig;
	} catch {
		return {};
	}
}

export function saveConfig(config: HostStackConfig): void {
	const dir = configDir();
	const file = configFile();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(file, JSON.stringify(config, null, 2) + '\n', {
		encoding: 'utf-8',
		mode: 0o600,
	});
	// The `mode` option above only applies when the file is newly created;
	// on an existing file it's ignored. The config holds a plaintext API
	// key, so enforce 0600 (and 0700 on the dir) on every write.
	chmodSync(dir, 0o700);
	chmodSync(file, 0o600);
}

export function getApiKey(): string | null {
	const envKey = process.env.HOSTSTACK_API_KEY;
	if (envKey) return envKey;
	return loadConfig().apiKey ?? null;
}

export function getApiUrl(): string {
	const envUrl = process.env.HOSTSTACK_API_URL;
	if (envUrl) return envUrl;
	return loadConfig().apiUrl ?? 'https://hoststack.dev';
}

export function getTeamId(): number | null {
	const envTeam = process.env.HOSTSTACK_TEAM_ID;
	if (envTeam) {
		const parsed = Number.parseInt(envTeam, 10);
		// Guard against a malformed env var producing NaN, which would
		// otherwise be interpolated into request URLs as `/services/NaN/...`.
		if (!Number.isInteger(parsed)) {
			throw new Error(`Invalid HOSTSTACK_TEAM_ID: "${envTeam}" is not a number`);
		}
		return parsed;
	}
	return loadConfig().teamId ?? null;
}
