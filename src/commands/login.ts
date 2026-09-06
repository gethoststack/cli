import { AuthenticationError, ForbiddenError, HostStack } from '@hoststack.dev/sdk';

import { getApiUrl, loadConfig, saveConfig } from '../lib/config.ts';
import { bold, green, handleError, red, spinner } from '../lib/output.ts';
import { USER_AGENT } from '../lib/version.ts';

export async function loginCommand(args: string[]): Promise<void> {
	const keyIndex = args.indexOf('--key');
	if (keyIndex === -1 || !args[keyIndex + 1]) {
		console.log(`${bold('Usage:')} hoststack login --key <api-key>`);
		console.log();
		console.log('Get your API key from: https://hoststack.dev/dashboard/settings/api-keys');
		console.log();
		console.log('Options:');
		console.log('  --key <key>    Your HostStack API key (hs_live_... or hs_test_...)');
		console.log('  --url <url>    Custom API URL (default: https://hoststack.dev)');
		process.exit(1);
	}

	const key = args[keyIndex + 1]!;
	const urlIndex = args.indexOf('--url');
	const customUrl = urlIndex !== -1 ? args[urlIndex + 1] : undefined;

	const s = spinner('Validating API key...');

	try {
		// Validate the candidate key against /api/auth/me. We build a transient
		// SDK client (the key isn't saved yet, so the cached client can't be
		// used). The SDK supplies the timeout/retry/User-Agent and typed errors.
		const apiUrl = customUrl ?? getApiUrl();
		const client = new HostStack({ apiKey: key, baseUrl: apiUrl, userAgent: USER_AGENT });

		let data: {
			// API-key auth has no associated user — `/api/auth/me` returns
			// `user: null` for key-bound clients. Guard the dereferences below
			// instead of crashing with `null is not an object`.
			user: { name: string; email: string } | null;
			team?: { id: number; name: string } | null;
		};
		try {
			data = await client.me();
		} catch (err: unknown) {
			// Only a 401/403 actually means the key is bad. A timeout, network
			// failure, or 5xx is also a HostStackError now (post-SDK-migration)
			// — those must surface their real message, not "Invalid API key".
			if (err instanceof AuthenticationError || err instanceof ForbiddenError) {
				s.stop(red('Invalid API key'));
				process.exit(1);
			}
			throw err;
		}
		s.stop('API key validated');

		const config = loadConfig();
		config.apiKey = key;
		if (customUrl) config.apiUrl = customUrl;
		if (data.team) config.teamId = data.team.id;
		saveConfig(config);

		console.log();
		if (data.user) {
			console.log(`${green('Logged in')} as ${bold(data.user.name)} (${data.user.email})`);
		} else {
			console.log(`${green('Logged in')} with API key`);
		}
		if (data.team) {
			console.log(`Active team: ${bold(data.team.name)}`);
		}
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
