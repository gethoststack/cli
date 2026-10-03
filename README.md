# @hoststack.dev/cli

Official command-line interface for [HostStack](https://hoststack.dev) — the European PaaS for deploying web services, databases, cron jobs, and domains on Hetzner infrastructure.

> Think Render.com, but hosted in Europe, built for developers who care about latency and data residency.

[![npm version](https://img.shields.io/npm/v/@hoststack.dev/cli.svg)](https://www.npmjs.com/package/@hoststack.dev/cli)
[![npm downloads](https://img.shields.io/npm/dm/@hoststack.dev/cli.svg)](https://www.npmjs.com/package/@hoststack.dev/cli)
[![MIT license](https://img.shields.io/npm/l/@hoststack.dev/cli.svg)](./LICENSE)

- **Website:** [hoststack.dev](https://hoststack.dev)
- **Documentation:** [hoststack.dev/docs](https://hoststack.dev/docs)
- **CLI reference:** [hoststack.dev/docs/cli](https://hoststack.dev/docs/cli)
- **Source:** [github.com/gethoststack/cli](https://github.com/gethoststack/cli)

## Installation

```bash
npm install -g @hoststack.dev/cli
# or
bun add -g @hoststack.dev/cli
# or
pnpm add -g @hoststack.dev/cli
```

Requires Node.js 18+.

## Quick start

```bash
# Authenticate with an API key from hoststack.dev → Settings → API Keys
hoststack login --key hs_live_your_api_key

# Confirm you're in
hoststack whoami

# List your services
hoststack services list

# Which services deploy this repo automatically on push?
hoststack services list --repo owner/name --auto-deploy

# Stop a service deploying on push (deploy it deliberately instead)
hoststack services update svc_abc123 --no-auto-deploy

# Trigger a deploy
hoststack deploy trigger svc_abc123

# Tail runtime logs
hoststack logs svc_abc123
```

## Commands

**Auth**

- `hoststack login` — authenticate with your API key
- `hoststack whoami` — show current user and team

**Resources**

- `hoststack projects` — manage projects
- `hoststack services` — manage services (web, worker, cron, static site). `list` also filters
  on deploy wiring — `--repo <url|owner/name>`, `--branch <name>`, `--auto-deploy` /
  `--no-auto-deploy` — and `update <id>` changes build/runtime config (branch, auto-deploy,
  install/build/start commands, health checks, resources, scaling). `metrics <id>` reads CPU,
  memory against its limit, disk and network (`--history` for a series); `templates` lists the
  quickstart ids `create --template` takes; `links` / `link` / `unlink` bind any managed
  resource into a service, not just a database
- `hoststack domains` — manage custom domains: `list`, `add`, `verify`, `update`, `delete`. `update <id> --primary` nominates the service's canonical hostname — what `${service.url}` resolves to and what its uptime check probes. With none nominated all three fall back to the OLDEST domain on the service, which on a renamed host is the alias that redirects; `list` says so when it happens
- `hoststack dns` — authoritative DNS: `zones`, `records`, `add`, `update`, `delete`, `resync`, and `check <domain>` — which compares the nameservers we publish for a zone against the ones the parent registry actually names, so a zone that is hosted here but still delegated to a previous host is visible instead of silent
- `hoststack db` — manage databases (Postgres, MySQL, MariaDB, MongoDB, Redis); `db connect <id>` opens an interactive `psql` / `mysql` / `mongo` / `redis-cli` session. Also `restart` (bounce the container in place), `update` (rename, plan tier, grow the disk), `upgrade-version --to <v>` (in-place engine major upgrade) and `query <id> "<sql>"` — one statement, enforced read-only server-side inside a read-only transaction with a 30s timeout and a 1000-row cap, and audit-logged whatever the outcome
- `hoststack volumes` — manage persistent disks attached to a service: `list`, `create`, `resize`, `delete`, plus `backup <svc> <vol> on|off`, `backups` (the archives you can actually restore from) and `restore`. Volume backups are block-level tars of a live disk — crash consistent, not application consistent — so a container running its own database wants a dump as well
- `hoststack env` — manage environment variables (per service)
- `hoststack environments` — manage environments (production / staging / development / preview) per project
- `hoststack cron` — manage cron job executions

**Operations**

- `hoststack deploy` — trigger, list, cancel and roll back deployments. `diagnose <svc> <deploy>` is the whole story in one command — the deploy record, the build log tail, and the runtime log tail bounded by that deploy's own start time (skipped when the deploy never started a container, because the previous release's output reads exactly like the new one working). `promote <svc> <deploy> --to <env>` runs an already-built image in another environment without rebuilding
- `hoststack logs <service-id>` — stream runtime logs
- `hoststack errors` — exceptions your applications reported, grouped by cause: `list`, `show`, `resolve`, `ignore`, `fix` (hands the issue to a coding agent in the project's dev box), and `keys` to mint the write-only ingest key your app reports with
- `hoststack alerts` — what is on fire, and where the team is told about it. `list` aggregates flapping events into one row with a fire count and shows only what is still open (`--raw`, `--all` to widen); `resolve` says the condition ENDED and `ack` says only "I have seen it" — two different claims, deliberately two commands. `channels` manages Slack / Discord / email delivery, `channels test <id>` reports the delivery OUTCOME rather than the HTTP 200, and `events` lists everything a channel can subscribe to
- `hoststack activity` — the audit log: who changed what, and when, with `--action` / `--type` / `--user` / `--since` filters
- `hoststack uptime` — HostStack requesting a service's public URL on a schedule and alerting when it stops answering: `get`, `set`, `disable`, `rm`
- `hoststack infra` — the operator steps of an infrastructure machine's cutover (register, pairing token, machine policy and its project network pin, the project network's subnets, runtime profiles, release settings, adopted volumes, image builds, releases, the pipeline's release plan token), run with an infra operator token a HostStack operator minted for one project. It reads the token from `HOSTSTACK_INFRA_OPERATOR_TOKEN` only and never falls back to your API key; the API holds every call to that project and records it
- `hoststack report` — file a platform fault with the HostStack team. Naming a service attaches it, its latest deploy and that deploy's log server-side, so the report is what you observed and expected rather than a pasted log

**Infrastructure as code**

- `hoststack init` — generate a starter `hoststack.yaml`
- `hoststack validate` — validate your `hoststack.yaml`

Run `hoststack help` for the full list.

## Configuration

Config is stored at `~/.hoststack/config.json`. Environment variables override the config file:

| Variable                         | Description                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `HOSTSTACK_API_KEY`              | API key (e.g. `hs_live_…`)                                                             |
| `HOSTSTACK_API_URL`              | API base URL (defaults to `https://hoststack.dev`)                                     |
| `HOSTSTACK_TEAM_ID`              | Active team ID                                                                         |
| `HOSTSTACK_INFRA_OPERATOR_TOKEN` | Infra operator token for `hoststack infra` (`hsiot_…`); never saved to the config file |

## Related packages

- **[@hoststack.dev/sdk](https://www.npmjs.com/package/@hoststack.dev/sdk)** — TypeScript SDK for programmatic access
- **[@hoststack.dev/mcp](https://www.npmjs.com/package/@hoststack.dev/mcp)** — MCP server for Claude, Cursor, and other AI agents
- **Terraform provider** — see [hoststack.dev/docs](https://hoststack.dev/docs) for installation and resource reference

## Support

- Issues: [github.com/gethoststack/cli/issues](https://github.com/gethoststack/cli/issues)
- Docs: [hoststack.dev/docs](https://hoststack.dev/docs)
- Homepage: [hoststack.dev](https://hoststack.dev)

## License

MIT © [HostStack Contributors](https://hoststack.dev)
