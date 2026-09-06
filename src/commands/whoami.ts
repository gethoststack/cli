import { apiFetch } from '../lib/api.ts';
import { bold, cyan, dim, handleError } from '../lib/output.ts';

interface MeResponse {
	// API-key auth has no associated user; the API returns `user: null` for
	// key-bound clients alongside the team + apiKey context.
	user: {
		id: number;
		name: string;
		email: string;
		avatarUrl?: string | null;
	} | null;
	team?: {
		id: number;
		name: string;
		slug: string;
		role: string;
	} | null;
	apiKey?: { id: number; permission: string };
}

export async function whoamiCommand(): Promise<void> {
	try {
		const data = await apiFetch<MeResponse>('/api/auth/me');

		if (data.user) {
			console.log(`${bold('User:')}    ${data.user.name} ${dim(`<${data.user.email}>`)}`);
			console.log(`${bold('User ID:')} ${data.user.id}`);
		} else {
			console.log(`${bold('Auth:')}    API key`);
			if (data.apiKey) {
				console.log(
					`${bold('Key ID:')}  ${data.apiKey.id} ${dim(`(${data.apiKey.permission})`)}`,
				);
			}
		}
		if (data.team) {
			console.log();
			console.log(`${bold('Team:')}    ${data.team.name} ${dim(`(${data.team.slug})`)}`);
			console.log(`${bold('Team ID:')} ${data.team.id}`);
			console.log(`${bold('Role:')}    ${cyan(data.team.role)}`);
		}
	} catch (err) {
		handleError(err);
	}
}
