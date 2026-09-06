import { NotFoundError } from '@hoststack.dev/sdk';

import { getClient } from './api.ts';
import { red } from './output.ts';

/**
 * Resolve a project id from either a numeric id or a `prj_…` publicId.
 * Delegates to the SDK's resolver (cached per client instance). The API
 * expects numeric ids in JSON bodies; URL paths accept either.
 */
export async function resolveProjectId(teamId: number, input: string): Promise<number> {
	if (/^\d+$/.test(input)) return Number(input);
	if (input.startsWith('prj_')) {
		try {
			return await getClient().resolveId(input, { kind: 'project', teamId });
		} catch (err: unknown) {
			if (err instanceof NotFoundError) {
				console.error(red(`Project "${input}" not found in this team.`));
				process.exit(1);
			}
			throw err;
		}
	}
	console.error(
		red(
			`Invalid project id "${input}". Expected a numeric id or a publicId starting with "prj_".`,
		),
	);
	process.exit(1);
}

/**
 * Resolve a service id from either a numeric id or a `svc_…` publicId.
 *
 * Delegates to the SDK resolver, which (unlike the CLI's old team-wide
 * `/api/services/:teamId` lookup) falls back to `/api/dev-environments/:teamId`
 * on a miss — so a dev box's `svc_…` id resolves too. The old CLI path filtered
 * dev boxes out, which broke `hoststack dev delete svc_…` (roadmap #7).
 */
export async function resolveServiceId(teamId: number, input: string): Promise<number> {
	if (/^\d+$/.test(input)) return Number(input);
	if (input.startsWith('svc_')) {
		try {
			return await getClient().resolveId(input, { kind: 'service', teamId });
		} catch (err: unknown) {
			if (err instanceof NotFoundError) {
				console.error(red(`Service "${input}" not found in this team.`));
				process.exit(1);
			}
			throw err;
		}
	}
	console.error(
		red(
			`Invalid service id "${input}". Expected a numeric id or a publicId starting with "svc_".`,
		),
	);
	process.exit(1);
}
