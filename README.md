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
- `hoststack services` — manage services (web, worker, cron)
- `hoststack domains` — manage custom domains
- `hoststack db` — manage databases (Postgres, Redis); `db connect <id>` opens an interactive `psql` / `redis-cli` session
- `hoststack env` — manage environment variables
- `hoststack cron` — manage cron job executions

**Operations**
- `hoststack deploy` — trigger, list, and cancel deployments
- `hoststack logs <service-id>` — stream runtime logs

**Infrastructure as code**
- `hoststack init` — generate a starter `hoststack.yaml`
- `hoststack validate` — validate your `hoststack.yaml`

Run `hoststack help` for the full list.

## Configuration

Config is stored at `~/.hoststack/config.json`. Environment variables override the config file:

| Variable | Description |
| --- | --- |
| `HOSTSTACK_API_KEY` | API key (e.g. `hs_live_…`) |
| `HOSTSTACK_API_URL` | API base URL (defaults to `https://api.hoststack.dev`) |
| `HOSTSTACK_TEAM_ID` | Active team ID |

## Related packages

- **[@hoststack.dev/sdk](https://www.npmjs.com/package/@hoststack.dev/sdk)** — TypeScript SDK for programmatic access
- **[Terraform provider](https://github.com/gethoststack/terraform-provider-hoststack)** — manage HostStack resources as IaC

## Support

- Issues: [github.com/gethoststack/cli/issues](https://github.com/gethoststack/cli/issues)
- Docs: [hoststack.dev/docs](https://hoststack.dev/docs)
- Homepage: [hoststack.dev](https://hoststack.dev)

## License

MIT © [HostStack Contributors](https://hoststack.dev)
