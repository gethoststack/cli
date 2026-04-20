import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface HostStackConfig {
	apiKey?: string;
	apiUrl?: string;
	teamId?: number;
}

const CONFIG_DIR = join(homedir(), '.hoststack');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function loadConfig(): HostStackConfig {
	if (!existsSync(CONFIG_FILE)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as HostStackConfig;
	} catch {
		return {};
	}
}

export function saveConfig(config: HostStackConfig): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
		encoding: 'utf-8',
		mode: 0o600,
	});
}

export function getApiKey(): string | null {
	const envKey = process.env.HOSTSTACK_API_KEY;
	if (envKey) return envKey;
	return loadConfig().apiKey ?? null;
}

export function getApiUrl(): string {
	const envUrl = process.env.HOSTSTACK_API_URL;
	if (envUrl) return envUrl;
	return loadConfig().apiUrl ?? 'http://localhost:3002';
}

export function getTeamId(): number | null {
	const envTeam = process.env.HOSTSTACK_TEAM_ID;
	if (envTeam) return parseInt(envTeam, 10);
	return loadConfig().teamId ?? null;
}
