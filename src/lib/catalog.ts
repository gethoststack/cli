/**
 * Two lists the CLI has to know by VALUE rather than by type.
 *
 * Both live in `@hoststack/shared`, which is `private: true`. This package
 * publishes to npm, so anything the bundle reaches cannot come from it — the
 * same rule the locale in `format.ts` and the volume/machine types are
 * restated under. The SDK exports `NotificationChannelEvent`, but a union TYPE
 * has no runtime members: you cannot print it, and `hoststack alerts channels
 * add --events …` is unusable without a way to see what the event names are.
 *
 * So they are copied, and `__tests__/shared-parity.test.ts` compares the copy
 * against the source. That test imports `@hoststack/shared` at DEV time only —
 * a test file is not an entry point, tsup builds `src/index.ts` and nothing
 * reaches this from there — so the guard costs zero shipped bytes. The same
 * trick in the MCP package caught both of its mirrors after they had drifted
 * (the event list by nine values, the template catalog by five) behind a
 * comment promising they were kept in sync by hand.
 */

/**
 * Every event a notification channel can subscribe to.
 *
 * Mirror of `NOTIFICATION_CHANNEL_EVENTS` in
 * `packages/shared/src/schemas/notification-channel.ts`. The API validates
 * against the source, so an event missing here is one a CLI user cannot
 * discover, not one they cannot send.
 */
export const NOTIFICATION_EVENTS = [
	'deploy.started',
	'deploy.succeeded',
	'deploy.failed',
	'deploy.failed_consecutive',
	'service.created',
	'service.deleted',
	'service.suspended',
	'service.resumed',
	'service.restart_failed',
	'service.no_running_container',
	'service.health_check_failed',
	'service.acme_cert_failed',
	'service.resource_alert',
	'service.pressure_sustained',
	'service.pressure_recovered',
	'service.uptime_down',
	'service.uptime_recovered',
	'watchdog.reported_down',
	'watchdog.reported_recovered',
	'watchdog.silent',
	'error.issue_new',
	'error.issue_regressed',
	'git.auth_failed',
	'cron.execution_failed',
	'cron.schedule_missed',
	'workflow.failed',
	'devenv.agent.needs_input',
	'devenv.agent.finished',
	'devenv.task.created',
	'devenv.task.needs_input',
	'devenv.task.finished',
	'database.backup_failed',
	'database.backup_overdue',
	'database.failed',
	'database.restore_failed',
	'volume.backup_failed',
	'volume.backup_overdue',
	'dns.registry_status_changed',
	'dns.registry_expiring',
	'dns.registry_domain_missing',
	'dns.registry_record_changed',
	'domain.registrant_verification_lapsed',
	'service.auto_restarted',
	'project.release_awaiting_start',
	'machine.offline',
	'machine.online',
	'billing.invoice',
	'billing.payment_failed',
	'billing.spend_limit',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** True when `value` is an event the platform actually publishes. */
export function isNotificationEvent(value: string): value is NotificationEvent {
	return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/**
 * A quickstart template, reduced to the fields a caller has to SEND.
 *
 * Everything else a template declares — its volumes, scratch dirs, `runAsUser`,
 * generated secrets, companion managed database, health-check grace period — is
 * resolved server-side from the template id and cannot be put in a request
 * body at all, so mirroring it here would only describe a payload nobody is
 * allowed to write. `dockerImage` and `port` ARE mirrored because the API takes
 * those two off the wire even for a template: `--template wordpress` on its own
 * creates a service with no image.
 */
export interface AppTemplate {
	id: string;
	name: string;
	type: 'web_service' | 'private_service' | 'worker' | 'cron_job' | 'static_site';
	description: string;
	/** Image templates only. Must be passed to `services create` alongside the id. */
	dockerImage?: string;
	/** Image templates only. The port the image fixes, which the platform publishes and health-checks. */
	port?: number;
}

/** Mirror of `APP_TEMPLATES` in `packages/shared/src/templates.ts`, in order. */
export const APP_TEMPLATES: readonly AppTemplate[] = [
	{
		id: 'node-express',
		name: 'Node.js Express',
		type: 'web_service',
		description: 'HTTP server with Express.js',
	},
	{
		id: 'python-fastapi',
		name: 'Python FastAPI',
		type: 'web_service',
		description: 'Modern Python API framework',
	},
	{
		id: 'go-api',
		name: 'Go HTTP Server',
		type: 'web_service',
		description: 'Lightweight Go web service',
	},
	{
		id: 'bun-hono',
		name: 'Bun + Hono',
		type: 'web_service',
		description: 'Fast TypeScript API with Bun runtime',
	},
	{
		id: 'nextjs-ssr',
		name: 'Next.js',
		type: 'web_service',
		description: 'Server-rendered Next.js started with next start',
	},
	{
		id: 'react-router-ssr',
		name: 'React Router / Remix',
		type: 'web_service',
		description: 'Server build served by react-router-serve or remix-serve',
	},
	{
		id: 'sveltekit-node',
		name: 'SvelteKit',
		type: 'web_service',
		description: 'SvelteKit server build produced by adapter-node',
	},
	{
		id: 'nuxt',
		name: 'Nuxt',
		type: 'web_service',
		description: 'Nuxt server build running on the Nitro output',
	},
	{
		id: 'django',
		name: 'Django',
		type: 'web_service',
		description: 'Django project served by Gunicorn',
	},
	{
		id: 'flask',
		name: 'Flask',
		type: 'web_service',
		description: 'Flask app served by Gunicorn',
	},
	{
		id: 'spring-boot',
		name: 'Spring Boot',
		type: 'web_service',
		description: 'Spring Boot fat JAR built with Maven or Gradle',
	},
	{
		id: 'static-react',
		name: 'React SPA',
		type: 'static_site',
		description: 'Single-page React application',
	},
	{
		id: 'static-nextjs',
		name: 'Next.js Static',
		type: 'static_site',
		description: 'Next.js with static export',
	},
	{
		id: 'astro',
		name: 'Astro',
		type: 'static_site',
		description: "Astro site built to Astro's default static output",
	},
	{
		id: 'worker-bullmq',
		name: 'BullMQ Worker',
		type: 'worker',
		description: 'Background job processor',
	},
	{
		id: 'uptime-kuma',
		name: 'Uptime Kuma',
		type: 'web_service',
		description: 'Self-hosted uptime monitoring and status pages, with its own SQLite store',
		dockerImage: 'louislam/uptime-kuma:1',
		port: 3000,
	},
	{
		id: 'vaultwarden',
		name: 'Vaultwarden',
		type: 'web_service',
		description: 'Self-hosted Bitwarden-compatible password manager (unofficial server)',
		dockerImage: 'vaultwarden/server:1.32.7-alpine',
		port: 3000,
	},
	{
		id: 'n8n',
		name: 'n8n',
		type: 'web_service',
		description: 'Self-hosted workflow automation — visual editor, 400+ integrations',
		dockerImage: 'n8nio/n8n:1',
		port: 5678,
	},
	{
		id: 'wordpress',
		name: 'WordPress',
		type: 'web_service',
		description: 'PHP 8.3 + Apache, with a managed MySQL database (billed separately)',
		dockerImage: 'wordpress:php8.3-apache',
		port: 80,
	},
	{
		id: 'ghost',
		name: 'Ghost',
		type: 'web_service',
		description: 'Blogs and newsletters, with a managed MySQL database (billed separately)',
		dockerImage: 'ghost:5-alpine',
		port: 2368,
	},
	{
		id: 'cron-cleanup',
		name: 'Cleanup Cron',
		type: 'cron_job',
		description: 'Daily maintenance task',
	},
];
