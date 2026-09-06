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
  install/build/start commands, health checks, resources, scaling)
- `hoststack domains` — manage custom domains
- `hoststack db` — manage databases (Postgres, MySQL, MariaDB, MongoDB, Redis); `db connect <id>` opens an interactive `psql` / `mysql` / `mongo` / `redis-cli` session
- `hoststack volumes` — manage persistent disks attached to a service
- `hoststack env` — manage environment variables (per service)
- `hoststack environments` — manage environments (production / staging / development / preview) per project
- `hoststack cron` — manage cron job executions

**Operations**

- `hoststack deploy` — trigger, list, and cancel deployments
- `hoststack logs <service-id>` — stream runtime logs
- `hoststack errors` — exceptions your applications reported, grouped by cause: `list`, `show`, `resolve`, `ignore`, `fix` (hands the issue to a coding agent in the project's dev box), and `keys` to mint the write-only ingest key your app reports with
- `hoststack uptime` — HostStack requesting a service's public URL on a schedule and alerting when it stops answering: `get`, `set`, `disable`, `rm`

**Infrastructure as code**

- `hoststack init` — generate a starter `hoststack.yaml`
- `hoststack validate` — validate your `hoststack.yaml`

Run `hoststack help` for the full list.

## Configuration

Config is stored at `~/.hoststack/config.json`. Environment variables override the config file:

| Variable            | Description                                        |
| ------------------- | -------------------------------------------------- |
| `HOSTSTACK_API_KEY` | API key (e.g. `hs_live_…`)                         |
| `HOSTSTACK_API_URL` | API base URL (defaults to `https://hoststack.dev`) |
| `HOSTSTACK_TEAM_ID` | Active team ID                                     |

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
