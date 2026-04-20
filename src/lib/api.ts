import { getApiKey, getApiUrl } from './config.ts';

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new Error('Not authenticated. Run: hoststack login --key <your-api-key>');
	}

	const url = `${getApiUrl()}${path}`;
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			...options?.headers,
		},
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({ error: 'Request failed' }))) as {
			error?: string;
		};
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}

	return res.json() as Promise<T>;
}
