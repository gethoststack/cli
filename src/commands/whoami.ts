import { apiFetch } from '../lib/api.ts';
import { bold, cyan, dim, handleError } from '../lib/output.ts';

interface MeResponse {
	user: {
		id: number;
		name: string;
		email: string;
		avatarUrl?: string | null;
	};
	team?: {
		id: number;
		name: string;
		slug: string;
		role: string;
	};
}

export async function whoamiCommand(): Promise<void> {
	try {
		const data = await apiFetch<MeResponse>('/api/auth/me');

		console.log(`${bold('User:')}    ${data.user.name} ${dim(`<${data.user.email}>`)}`);
		console.log(`${bold('User ID:')} ${data.user.id}`);
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
