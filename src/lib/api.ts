import { HostStack } from '@hoststack.dev/sdk';

import { getApiKey, getApiUrl } from './config.ts';
import { USER_AGENT } from './version.ts';

// The CLI's HTTP layer is the SDK. Routing every request through one shared
// `HostStack` instance gives the CLI the SDK's request timeout, retry-on-429/5xx
// (honoring Retry-After), typed errors, and versioned User-Agent
// (`hoststack-sdk/<v>`) for free — instead of the CLI's old bare `fetch` that
// reimplemented auth/error-typing and had none of those guardrails.
//
// The client is created lazily (and cached) on first use so commands that don't
// hit the network — `hoststack --help`, `hoststack login` — never require an
// API key to be present.
let cachedClient: HostStack | null = null;
let cachedKey: string | null = null;
let cachedUrl: string | null = null;

/** The shared SDK client for the active credentials. Throws if unauthenticated. */
export function getClient(): HostStack {
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new Error('Not authenticated. Run: hoststack login --key <your-api-key>');
	}
	const baseUrl = getApiUrl();
	// Rebuild if the credentials changed mid-process (tests, env overrides).
	if (!cachedClient || cachedKey !== apiKey || cachedUrl !== baseUrl) {
		// Identify as `hoststack-cli/<v>` (not the SDK's default UA) so the API
		// attributes CLI traffic correctly for per-client rate limits.
		cachedClient = new HostStack({ apiKey, baseUrl, userAgent: USER_AGENT });
		cachedKey = apiKey;
		cachedUrl = baseUrl;
	}
	return cachedClient;
}

/**
 * Backwards-compatible request helper. Mirrors the old `fetch`-style signature
 * (`apiFetch<T>(path, { method, body })`) so every existing command keeps
 * working unchanged, but delegates to the SDK's `request()` under the hood.
 *
 * `options.body` is a pre-serialized JSON string in the existing call sites; we
 * parse it back before handing it to the SDK (which serializes itself). A
 * non-JSON string body is passed through as-is.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const method = (options?.method ?? 'GET').toUpperCase();
	const body = parseBody(options?.body);
	return getClient().request<T>(method, path, body);
}

function parseBody(body: RequestInit['body']): unknown {
	if (body === undefined || body === null) return undefined;
	if (typeof body !== 'string') return body;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
