import { getApiUrl, loadConfig, saveConfig } from '../lib/config.ts';
import { bold, green, handleError, red, spinner } from '../lib/output.ts';

export async function loginCommand(args: string[]): Promise<void> {
	const keyIndex = args.indexOf('--key');
	if (keyIndex === -1 || !args[keyIndex + 1]) {
		console.log(`${bold('Usage:')} hoststack login --key <api-key>`);
		console.log();
		console.log('Get your API key from: https://hoststack.dev/dashboard/settings/api-keys');
		console.log();
		console.log('Options:');
		console.log('  --key <key>    Your HostStack API key (hs_live_... or hs_test_...)');
		console.log('  --url <url>    Custom API URL (default: http://localhost:3002)');
		process.exit(1);
	}

	const key = args[keyIndex + 1]!;
	const urlIndex = args.indexOf('--url');
	const customUrl = urlIndex !== -1 ? args[urlIndex + 1] : undefined;

	const s = spinner('Validating API key...');

	try {
		const apiUrl = customUrl ?? getApiUrl();
		const res = await fetch(`${apiUrl}/api/auth/me`, {
			headers: { Authorization: `Bearer ${key}` },
		});

		if (!res.ok) {
			s.stop(red('Invalid API key'));
			process.exit(1);
		}

		const data = (await res.json()) as {
			user: { name: string; email: string };
			team?: { id: number; name: string };
		};
		s.stop('API key validated');

		const config = loadConfig();
		config.apiKey = key;
		if (customUrl) config.apiUrl = customUrl;
		if (data.team) config.teamId = data.team.id;
		saveConfig(config);

		console.log();
		console.log(`${green('Logged in')} as ${bold(data.user.name)} (${data.user.email})`);
		if (data.team) {
			console.log(`Active team: ${bold(data.team.name)}`);
		}
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
