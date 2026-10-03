/**
 * Drift guards for the two lists this package copies out of
 * `@hoststack/shared` by hand.
 *
 * The copies exist because `@hoststack.dev/cli` publishes to npm and
 * `@hoststack/shared` is `private: true`, so importing it from anything the
 * bundle reaches would drag the monorepo into the published artifact. A TEST
 * file reaches the bundle from nowhere — tsup builds `src/index.ts` and
 * nothing it imports leads here — so the source of truth can be compared
 * against at zero shipped bytes.
 *
 * That is the whole trick, and it is worth more than the syncs it forces. The
 * MCP package's equivalent mirrors had both silently drifted (its event list
 * by nine values, its template catalog by five), each behind a comment
 * promising they were kept in sync manually.
 */
import { describe, expect, it } from 'bun:test';

import { APP_TEMPLATES as SHARED_TEMPLATES } from '@hoststack/shared/src/templates';
import { NOTIFICATION_CHANNEL_EVENTS } from '@hoststack/shared/src/schemas/notification-channel';

import { APP_TEMPLATES, NOTIFICATION_EVENTS, isNotificationEvent } from '../lib/catalog.ts';

describe('NOTIFICATION_EVENTS mirrors the platform list', () => {
	it('carries every event, in order, and only events that exist', () => {
		expect([...NOTIFICATION_EVENTS]).toEqual([...NOTIFICATION_CHANNEL_EVENTS]);
	});

	it('recognises a real event and rejects a plausible invention', () => {
		// `--events` is validated against this list before the request goes
		// out, so a stale copy turns into "Not an event:" for something the
		// API would have accepted.
		expect(isNotificationEvent('deploy.failed')).toBe(true);
		expect(isNotificationEvent('deploy.broke')).toBe(false);
	});
});

describe('APP_TEMPLATES mirrors the quickstart catalog', () => {
	it('carries every template, in order, and only templates that exist', () => {
		expect(APP_TEMPLATES.map((t) => t.id)).toEqual(SHARED_TEMPLATES.map((t) => t.id));
	});

	it('keeps name, type, description, image and port identical to the source', () => {
		for (const template of APP_TEMPLATES) {
			const source = SHARED_TEMPLATES.find((t) => t.id === template.id);
			expect(source).toBeDefined();
			expect(template.name).toBe(source!.name);
			expect(template.type).toBe(source!.type);
			expect(template.description).toBe(source!.description);
			// `undefined` on both sides for a source-built template.
			expect(template.dockerImage).toBe(source!.dockerImage);
			expect(template.port).toBe(source!.port);
		}
	});

	it('gives every image template the two fields `services create` must be sent', () => {
		// `--template wordpress` alone does not deploy one of these: the API
		// resolves the volume, scratch dirs, uid and companion database from
		// the id, but takes the image and port off the wire. A mirrored image
		// template missing either is a create call that fails at the API.
		for (const template of APP_TEMPLATES) {
			if (template.dockerImage === undefined) continue;
			expect(template.port).toBeGreaterThan(0);
		}
	});
});
