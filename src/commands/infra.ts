import { readFileSync } from 'node:fs';

import { HostStack } from '@hoststack.dev/sdk';

import { getApiUrl } from '../lib/config.ts';
import { bold, dim, handleError, red, yellow } from '../lib/output.ts';
import { USER_AGENT } from '../lib/version.ts';

/**
 * `hoststack infra` — the operator steps of one infrastructure machine's cutover, run with a
 * cutover token rather than an API key.
 *
 * Two tokens reach these routes and they are not interchangeable:
 *
 * - **`HOSTSTACK_INFRA_OPERATOR_TOKEN`** (`hsiot_…`) is minted by a HostStack operator from an
 *   admin session, for one project and at most seven days. It runs everything here.
 * - **`HOSTSTACK_RELEASE_PLAN_TOKEN`** (`hsrpt_…`) is the narrow one, and the one you are MEANT to
 *   leave on a dev box — that is why it is scoped to planning and reading releases and given an
 *   expiry. It plans and reads; it starts a release only when it was minted with `--can-start`.
 *
 * Until task 447 this command read the first and had no code path for the second, so the supported
 * CLI worked with exactly the credential that should not be sitting on the machine where you would
 * type these commands, and not with the one that should. Both are read from the environment only:
 * they are short-lived credentials for one job, so neither is written to the config file.
 *
 * The API holds every call to the token's project, refuses the steps that could take a live service
 * down, and records each request; this command is a thin, exact wrapper over those routes. Bodies
 * that are more than a few fields (machine policy, runtime profile, release settings) come from a
 * JSON file, so what was applied is a file someone can read back.
 */

const OPERATOR_TOKEN_ENV = 'HOSTSTACK_INFRA_OPERATOR_TOKEN';
const PLAN_TOKEN_ENV = 'HOSTSTACK_RELEASE_PLAN_TOKEN';

/** What a plan token can run, said in the second person. Never names a token value. */
const PLAN_TOKEN_CAN_RUN =
	'release list, release plan, release get, and release start when it was minted with --can-start';

/**
 * Which credential a command needs.
 *
 * `either` is not "any token will do": it is the set of routes the API itself accepts a plan token
 * on. Start is in it because whether THIS plan token may start is a fact about the token record,
 * which only the API can read — so the CLI sends it and lets the refusal be specific, rather than
 * inventing a client-side rule that would be wrong for half the tokens.
 */
type Need = 'operator' | 'either' | 'plan';

interface Credential {
	env: string;
	token: string;
	kind: 'operator' | 'plan';
}

const clients = new Map<string, HostStack>();

function client(credential: Credential): HostStack {
	const existing = clients.get(credential.token);
	if (existing) return existing;
	// The SDK sends its key as the bearer, which is exactly how the API takes these tokens. No
	// retries: a register or a release start that timed out must be looked at, not sent twice.
	const created = new HostStack({
		apiKey: credential.token,
		baseUrl: getApiUrl(),
		userAgent: USER_AGENT,
		maxRetries: 0,
	});
	clients.set(credential.token, created);
	return created;
}

/** The token in `env`, or null when it is unset. A token of the wrong kind is an error, not a miss. */
function fromEnv(env: string, prefix: string, kind: Credential['kind']): Credential | null {
	const token = process.env[env];
	if (!token) return null;
	if (!token.startsWith(prefix)) {
		console.error(
			red(
				`${env} is not ${kind === 'operator' ? 'an infra operator' : 'a release plan'} token (they start with ${prefix}).`,
			),
		);
		process.exit(1);
	}
	return { env, token, kind };
}

/**
 * The credentials to try, best first.
 *
 * The operator token goes first because it is strictly more capable — but the plan token is not
 * ignored when it is there: an operator token that has expired while a valid plan token sits beside
 * it should still be able to read a release, so `send` falls through on a 401.
 */
function credentials(need: Need): Credential[] {
	const operator = fromEnv(OPERATOR_TOKEN_ENV, 'hsiot_', 'operator');
	const plan = fromEnv(PLAN_TOKEN_ENV, 'hsrpt_', 'plan');
	if (need === 'plan') {
		if (plan) return [plan];
		console.error(red(`No release plan token. Set ${PLAN_TOKEN_ENV} to the hsrpt_… token.`));
		process.exit(1);
	}
	if (need === 'operator') {
		if (operator) return [operator];
		// The old message said "set the operator token" to someone holding a perfectly valid plan
		// token for that exact project, which reads as "your token is not good enough" and points
		// at the one credential that should not be on this box. Say what is actually true.
		console.error(
			red(
				plan
					? `This command needs an infra operator token — set ${OPERATOR_TOKEN_ENV}. The release plan token in ${PLAN_TOKEN_ENV} can run: ${PLAN_TOKEN_CAN_RUN}.`
					: `No infra operator token. Set ${OPERATOR_TOKEN_ENV} to the hsiot_… token an operator minted for this project.`,
			),
		);
		process.exit(1);
	}
	const ordered = [operator, plan].filter((c): c is Credential => c !== null);
	if (ordered.length === 0) {
		console.error(
			red(
				`No token. Set ${OPERATOR_TOKEN_ENV} to an hsiot_… token, or ${PLAN_TOKEN_ENV} to the hsrpt_… plan token minted for this project.`,
			),
		);
		process.exit(1);
	}
	return ordered;
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx === -1 ? undefined : args[idx + 1];
}

function required(args: string[], name: string, usage: string): string {
	const value = flag(args, name);
	if (value === undefined || value.startsWith('--')) usageExit(usage);
	return value;
}

function positional(args: string[], index: number, usage: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith('--')) usageExit(usage);
	return value;
}

function numeric(value: string, what: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) {
		console.error(red(`${what} must be a positive whole number, not "${value}".`));
		process.exit(1);
	}
	return n;
}

function usageExit(usage: string): never {
	console.log(`${bold('Usage:')} hoststack infra ${usage}`);
	process.exit(1);
}

/** A JSON object from `--file <path>`, or from stdin with `--file -`. */
function jsonFile(args: string[], usage: string): unknown {
	const path = required(args, '--file', usage);
	let text: string;
	try {
		text = readFileSync(path === '-' ? 0 : path, 'utf-8');
	} catch (err: unknown) {
		console.error(
			red(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`),
		);
		process.exit(1);
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('expected a JSON object');
		}
		return parsed;
	} catch (err: unknown) {
		console.error(
			red(
				`${path} is not a JSON object: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		process.exit(1);
	}
}

async function send(
	method: string,
	path: string,
	body?: unknown,
	need: Need = 'operator',
): Promise<void> {
	const tried = credentials(need);
	for (const [index, credential] of tried.entries()) {
		try {
			const result = await client(credential).request<unknown>(method, path, body);
			console.log(JSON.stringify(result, null, 2));
			return;
		} catch (err: unknown) {
			// A dead credential with a live one beside it is not a failure worth printing. Only a
			// 401 falls through — the token is not usable at all — never a 403, which is an answer
			// about this request and would be the same from the next token.
			const unauthenticated =
				err instanceof Error && 'statusCode' in err && err.statusCode === 401;
			if (unauthenticated && index < tried.length - 1) continue;
			handleError(err);
		}
	}
}

const SHA = /^[a-f0-9]{40}$/;

function commitSha(args: string[], usage: string): string {
	const sha = required(args, '--commit', usage);
	if (!SHA.test(sha)) {
		console.error(red('--commit must be a full 40-character commit SHA.'));
		process.exit(1);
	}
	return sha;
}

export async function infraCommand(args: string[]): Promise<void> {
	const [subcommand, ...rest] = args;

	switch (subcommand) {
		case 'register': {
			const usage =
				'register --team <team-id> --project <project-id> --name <name> --ip <address> [--region <region>]';
			const region = flag(rest, '--region');
			console.error(
				yellow(
					'The response carries a pairing token: a 15-minute, single-use credential that installs the agent as root. Treat it like a password.',
				),
			);
			return send('POST', '/api/admin/servers/infra', {
				teamId: numeric(required(rest, '--team', usage), '--team'),
				projectId: numeric(required(rest, '--project', usage), '--project'),
				name: required(rest, '--name', usage),
				ipAddress: required(rest, '--ip', usage),
				...(region ? { region } : {}),
			});
		}
		case 'pairing-token': {
			const usage = 'pairing-token <server-id>';
			const serverId = numeric(positional(rest, 0, usage), 'server-id');
			return send('POST', `/api/admin/servers/${serverId}/infra-pairing-token`);
		}
		case 'policy': {
			const usage = 'policy <server-id> [--file <policy.json | ->]';
			const serverId = numeric(positional(rest, 0, usage), 'server-id');
			// No --file reads it back (task 423): the file that wrote it was the only record of
			// what a machine allows, and it says nothing about what the machine is holding.
			return rest.includes('--file')
				? send('PUT', `/api/admin/servers/${serverId}/infra-policy`, jsonFile(rest, usage))
				: send('GET', `/api/admin/servers/${serverId}/infra-policy`);
		}
		case 'volumes': {
			const usage = 'volumes <server-id>';
			const serverId = numeric(positional(rest, 0, usage), 'server-id');
			return send('GET', `/api/admin/servers/${serverId}/infra-volumes`);
		}
		case 'image': {
			const usage = 'image <service-id>';
			const serviceId = numeric(positional(rest, 0, usage), 'service-id');
			return send('GET', `/api/admin/services/${serviceId}/configured-image`);
		}
		case 'network': {
			const usage = 'network <server-id> [--recreate]';
			const serverId = numeric(positional(rest, 0, usage), 'server-id');
			return rest.includes('--recreate')
				? send('POST', `/api/admin/servers/${serverId}/project-network/recreate`)
				: send('GET', `/api/admin/servers/${serverId}/project-network`);
		}
		case 'probe': {
			// Task 424: the acceptance check for a dual-stack publish is an EXTERNAL client's own
			// address in the container's log, and no dev box has IPv6 to provide one. This runs the
			// connection from another HostStack machine and prints the address it came from.
			const usage = 'probe <server-id> --port <port> [--ipv6] [--address <ip>]';
			const serverId = numeric(positional(rest, 0, usage), 'server-id');
			const address = flag(rest, '--address');
			return send('POST', `/api/admin/servers/${serverId}/net-probe`, {
				port: numeric(required(rest, '--port', usage), '--port'),
				...(rest.includes('--ipv6') ? { family: 'ipv6' as const } : {}),
				...(rest.includes('--ipv4') ? { family: 'ipv4' as const } : {}),
				...(address ? { address } : {}),
			});
		}
		case 'profile': {
			const [action, ...more] = rest;
			const base = (id: string) =>
				`/api/admin/services/${numeric(id, 'service-id')}/infra-profile`;
			if (action === 'get') {
				return send('GET', base(positional(more, 0, 'profile get <service-id>')));
			}
			if (action === 'set') {
				const usage = 'profile set <service-id> --file <profile.json | ->';
				return send('PUT', base(positional(more, 0, usage)), jsonFile(more, usage));
			}
			if (action === 'clear') {
				return send('DELETE', base(positional(more, 0, 'profile clear <service-id>')));
			}
			return usageExit('profile get|set|clear <service-id> [--file <profile.json | ->]');
		}
		case 'release-settings': {
			const usage = 'release-settings <service-id> --file <settings.json | -> | --remove';
			const serviceId = numeric(positional(rest, 0, usage), 'service-id');
			if (rest.includes('--remove')) {
				return send('DELETE', `/api/admin/services/${serviceId}/release-settings`);
			}
			return send(
				'PUT',
				`/api/admin/services/${serviceId}/release-settings`,
				jsonFile(rest, usage),
			);
		}
		case 'adopt': {
			const usage =
				'adopt <server-id> --volume <docker-volume-name> --service <owner-service-id> --path <mount-path> [--read-only]';
			const serverId = numeric(positional(rest, 0, usage), 'server-id');
			return send('POST', `/api/admin/servers/${serverId}/adopted-volumes`, {
				dockerName: required(rest, '--volume', usage),
				ownerServiceId: numeric(required(rest, '--service', usage), '--service'),
				mountPath: required(rest, '--path', usage),
				readOnly: rest.includes('--read-only'),
			});
		}
		case 'attach': {
			const usage =
				'attach <volume-id> --service <service-id> --path <mount-path> [--read-write]';
			const volumeId = numeric(positional(rest, 0, usage), 'volume-id');
			return send('POST', `/api/admin/volumes/${volumeId}/attachments`, {
				serviceId: numeric(required(rest, '--service', usage), '--service'),
				mountPath: required(rest, '--path', usage),
				readOnly: !rest.includes('--read-write'),
			});
		}
		case 'detach': {
			const usage = 'detach <volume-id> <attachment-id>';
			const volumeId = numeric(positional(rest, 0, usage), 'volume-id');
			const attachmentId = numeric(positional(rest, 1, usage), 'attachment-id');
			return send('DELETE', `/api/admin/volumes/${volumeId}/attachments/${attachmentId}`);
		}
		case 'forget': {
			const usage = 'forget <volume-id>';
			const volumeId = numeric(positional(rest, 0, usage), 'volume-id');
			return send('DELETE', `/api/admin/volumes/${volumeId}/adoption`);
		}
		case 'build': {
			const [action, ...more] = rest;
			if (action === 'get') {
				return send(
					'GET',
					`/api/admin/image-builds/${encodeURIComponent(positional(more, 0, 'build get <build-id>'))}`,
				);
			}
			const usage = 'build <service-id> --commit <sha>  |  build get <build-id>';
			const serviceId = numeric(positional(rest, 0, usage), 'service-id');
			return send('POST', `/api/admin/services/${serviceId}/image-builds`, {
				commitSha: commitSha(rest, usage),
			});
		}
		case 'release': {
			const [action, ...more] = rest;
			if (action === 'list') {
				// Until task 450 nothing listed releases at all, here or in the dashboard, so the
				// only way to name one was to have kept its id from the plan that made it.
				const usage = 'release list <project-id>';
				const projectId = numeric(positional(more, 0, usage), 'project-id');
				return send(
					'GET',
					`/api/admin/projects/${projectId}/releases`,
					undefined,
					'either',
				);
			}
			if (action === 'plan') {
				const usage =
					'release plan <project-id> --commit <sha> [--services <id,id,…>] [--full-rollout]';
				const projectId = numeric(positional(more, 0, usage), 'project-id');
				const named = more.includes('--services')
					? required(more, '--services', usage)
					: undefined;
				// Planning is a plan token's whole purpose, so either credential runs it. The API
				// refuses `--full-rollout` to a plan token; the CLI does not second-guess that.
				return send(
					'POST',
					`/api/admin/projects/${projectId}/releases`,
					{
						commitSha: commitSha(more, usage),
						allowFullRollout: more.includes('--full-rollout'),
						...(named === undefined
							? {}
							: {
									services: named
										.split(',')
										.map((id) => numeric(id.trim(), '--services')),
								}),
					},
					'either',
				);
			}
			if (
				action === 'get' ||
				action === 'start' ||
				action === 'cancel' ||
				action === 'rollback'
			) {
				const id = encodeURIComponent(
					positional(more, 0, `release ${action} <release-id>`),
				);
				// `get` is a read the API already serves a plan token, and `start` is one it serves
				// a token minted with the grant (task 446) — send it and let the refusal be
				// specific. Cancel and rollback are operator-only by design.
				const need: Need = action === 'get' || action === 'start' ? 'either' : 'operator';
				return action === 'get'
					? send('GET', `/api/admin/releases/${id}`, undefined, need)
					: send('POST', `/api/admin/releases/${id}/${action}`, undefined, need);
			}
			return usageExit('release list|plan|get|start|cancel|rollback …');
		}
		case 'plan-token': {
			// Minting is the default verb, and it mints on every invocation — so `list` and
			// `revoke` are what lets an operator find and clean up a token they minted while
			// looking at the output shape (task 427).
			const action = rest[0];
			// The token in YOUR environment, read without using it (task 451): project, grant,
			// expiry, the box it is bound to, and — for a dead one — exactly why. Answers for an
			// expired token too, which is when a pipeline most needs to ask, before its gate.
			if (action === 'whoami') {
				return send('GET', '/api/admin/release-plan-token', undefined, 'plan');
			}
			if (action === 'list') {
				const usage = 'plan-token list <project-id>';
				const projectId = numeric(positional(rest, 1, usage), 'project-id');
				return send('GET', `/api/admin/projects/${projectId}/release-plan-tokens`);
			}
			if (action === 'revoke') {
				const usage = 'plan-token revoke <project-id> <token-id>';
				const projectId = numeric(positional(rest, 1, usage), 'project-id');
				const tokenId = encodeURIComponent(positional(rest, 2, usage));
				return send(
					'POST',
					`/api/admin/projects/${projectId}/release-plan-tokens/${tokenId}/revoke`,
				);
			}
			const usage =
				'plan-token <project-id> --name <name> --days <1-365> [--can-start] [--dev-box <svc_…>]';
			const projectId = numeric(positional(rest, 0, usage), 'project-id');
			// --dev-box binds it to a dev box of your own (task 451): the platform seeds it into
			// that box and replaces it before it lapses, so the box never has to be handed one.
			const devBox = rest.includes('--dev-box')
				? required(rest, '--dev-box', usage)
				: undefined;
			// --can-start is the whole operator decision, taken once here rather than on every
			// release by whoever reads a dashboard (task 446). Off unless asked for, and printed
			// back on `plan-token list`, so nobody has to run a release to find out.
			return send('POST', `/api/admin/projects/${projectId}/release-plan-tokens`, {
				name: required(rest, '--name', usage),
				expiresInDays: numeric(required(rest, '--days', usage), '--days'),
				...(rest.includes('--can-start') ? { canStart: true } : {}),
				...(devBox === undefined ? {} : { devBox }),
			});
		}
		case 'operator-token': {
			// Not minting: an operator token can never make another, and that stays with an
			// admin session. What an operator can now do is see the tokens of their project,
			// read what one actually did, and take one back — including the one in their hand
			// (task 428). Revoking yourself is the reason this exists: a pipeline that has
			// finished should be able to hand its own credential in.
			const action = rest[0];
			if (action === 'list') {
				const usage = 'operator-token list <project-id>';
				const projectId = numeric(positional(rest, 1, usage), 'project-id');
				return send('GET', `/api/admin/projects/${projectId}/infra-operator-tokens`);
			}
			if (action === 'uses') {
				const usage = 'operator-token uses <project-id> <token-id>';
				const projectId = numeric(positional(rest, 1, usage), 'project-id');
				const tokenId = encodeURIComponent(positional(rest, 2, usage));
				return send(
					'GET',
					`/api/admin/projects/${projectId}/infra-operator-tokens/${tokenId}/uses`,
				);
			}
			if (action === 'revoke') {
				const usage = 'operator-token revoke <project-id> <token-id>';
				const projectId = numeric(positional(rest, 1, usage), 'project-id');
				const tokenId = encodeURIComponent(positional(rest, 2, usage));
				return send(
					'POST',
					`/api/admin/projects/${projectId}/infra-operator-tokens/${tokenId}/revoke`,
				);
			}
			return usageExit('operator-token list|uses|revoke …');
		}
		default:
			printUsage();
			process.exit(subcommand === undefined || subcommand === 'help' ? 0 : 1);
	}
}

function printUsage(): void {
	console.log(`${bold('Usage:')} hoststack infra <command>

Run the operator steps of one infrastructure machine's cutover. Every call is
held to the token's project and recorded.

${bold('Tokens')}
  ${OPERATOR_TOKEN_ENV}
      An hsiot_… token an operator minted for the project. Runs everything here.
  ${PLAN_TOKEN_ENV}
      An hsrpt_… token. Runs ${dim('release plan')}, ${dim('release get')}, and ${dim('release start')} when it
      was minted with --can-start. This is the one meant to live on a dev box.

Both are read from the environment only, never the config file. With both set
the operator token is used, and a read falls back to the plan token if the
operator token has expired.

${bold('Machine')}
  register --team <id> --project <id> --name <name> --ip <address> [--region <r>]
  pairing-token <server-id>                    ${dim('only before the machine has paired')}
  policy <server-id> [--file <policy.json>]     ${dim('no --file prints the stored policy')}
  network <server-id> [--recreate]             ${dim('its subnets and what containers reach the internet FROM; --recreate makes it dual-stack (nothing attached)')}
  probe <server-id> --port <p> [--ipv6]        ${dim('connects from another HostStack machine; prints the source address')}

${bold('Services')}
  image <service-id>                           ${dim('the image it is configured to run, digest included')}
  profile get|set|clear <service-id> [--file <profile.json>]
  release-settings <service-id> --file <settings.json>
  release-settings <service-id> --remove       ${dim('takes it out of releases')}

${bold('Volumes')}
  volumes <server-id>                          ${dim('every adopted volume and attachment, with mount paths')}
  adopt <server-id> --volume <name> --service <id> --path <mount> [--read-only]
  attach <volume-id> --service <id> --path <mount> [--read-write]
  detach <volume-id> <attachment-id>
  forget <volume-id>

${bold('Builds and releases')} ${dim('(plan / get / start take either token; the rest need the operator one)')}
  build <service-id> --commit <sha>
  build get <build-id>
  release list <project-id>                    ${dim("the project's releases, newest first — either token")}
  release plan <project-id> --commit <sha> [--services <id,id>] [--full-rollout]
  release get <release-id>                     ${dim('either token')}
  release start <release-id>                   ${dim('either, if the plan token was minted --can-start')}
  release cancel|rollback <release-id>         ${dim('operator token only')}
  plan-token <project-id> --name <name> --days <1-365> [--can-start] [--dev-box <svc_…>]
                                               ${dim('mints one, every time it is run; --can-start also lets it START a release')}
                                               ${dim('--dev-box: your own box is seeded with it and it is renewed before it lapses')}
  plan-token list <project-id>                 ${dim('every plan token of the project: status, whether it can start, which box holds it')}
  plan-token whoami                            ${dim('the plan token in your environment: expiry, grant, box, and why it fails if it does')}
  plan-token revoke <project-id> <token-id>

${bold('This token and its siblings')}
  operator-token list <project-id>             ${dim('every hsiot_ token of the project, with status and last use')}
  operator-token uses <project-id> <token-id>  ${dim('what it actually did — read this before deciding a revoke is urgent')}
  operator-token revoke <project-id> <token-id> ${dim('including the one you are using; minting still needs an operator')}

${dim('--file - reads the JSON body from stdin. Output is the API response as JSON.')}`);
}
