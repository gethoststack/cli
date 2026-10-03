import { activityCommand } from './commands/activity.ts';
import { alertsCommand } from './commands/alerts.ts';
import { cronCommand } from './commands/cron.ts';
import { analyticsCommand } from './commands/analytics.ts';
import { errorsCommand } from './commands/errors.ts';
import { dbCommand } from './commands/db.ts';
import { deployCommand } from './commands/deploy.ts';
import { devCommand } from './commands/dev.ts';
import { dnsCommand } from './commands/dns.ts';
import { domainsCommand } from './commands/domains.ts';
import { envCommand } from './commands/env.ts';
import { environmentsCommand } from './commands/environments.ts';
import { githubCommand } from './commands/github.ts';
import { infraCommand } from './commands/infra.ts';
import { initCommand } from './commands/init.ts';
import { loginCommand } from './commands/login.ts';
import { machinesCommand } from './commands/machines.ts';
import { logsCommand } from './commands/logs.ts';
import { projectsCommand } from './commands/projects.ts';
import { reportCommand } from './commands/report.ts';
import { servicesCommand } from './commands/services.ts';
import { uptimeCommand } from './commands/uptime.ts';
import { validateCommand } from './commands/validate.ts';
import { taskCommand } from './commands/task.ts';
import { volumesCommand } from './commands/volumes.ts';
import { whoamiCommand } from './commands/whoami.ts';
import { bold, cyan, dim } from './lib/output.ts';
import { CLI_VERSION } from './lib/version.ts';

// Injected from package.json at build time (see tsup.config.ts `define`) — no
// hand-maintained constant to drift from the published version.
const VERSION = CLI_VERSION;

function printHelp(): void {
	console.log(`
${bold('hoststack')} ${dim(`v${VERSION}`)} - Deploy and manage your HostStack services

${bold('USAGE')}
  hoststack <command> [options]

${bold('AUTH')}
  ${cyan('login')}       Authenticate with your API key
  ${cyan('whoami')}      Show current user and team info

${bold('RESOURCES')}
  ${cyan('projects')}    Manage projects
  ${cyan('services')}    Manage services (web, worker, cron)
  ${cyan('domains')}     Manage custom domains
  ${cyan('dns')}         Authoritative DNS — zones, records, and who the registry points at
  ${cyan('db')}          Manage databases (Postgres, Redis)
  ${cyan('volumes')}     Manage persistent disks
  ${cyan('env')}         Manage environment variables (per service)
  ${cyan('environments')} Manage environments (production/staging/dev) per project
  ${cyan('cron')}        Manage cron job executions
  ${cyan('dev')}         Spin up an AI dev environment (cloud terminal + agents)
  ${cyan('task')}        Queue work for a dev box (the agent task backlog)
  ${cyan('machines')}    Your own hardware, enrolled to run services and dev boxes
  ${cyan('infra')}       An infrastructure machine's cutover, run with an infra operator token

${bold('OPERATIONS')}
  ${cyan('deploy')}      Trigger and manage deployments
  ${cyan('logs')}        View runtime logs for a service
  ${cyan('errors')}      Exceptions your apps reported, grouped by cause
  ${cyan('alerts')}      What is on fire, and where the team is told about it
  ${cyan('activity')}    The audit log: who changed what, and when
  ${cyan('uptime')}      Watch a service's public URL and alert when it stops answering
  ${cyan('analytics')}   Cookieless traffic for every site you own, hosted here or not
  ${cyan('report')}      File a platform fault with the HostStack team

${bold('INFRASTRUCTURE AS CODE')}
  ${cyan('init')}        Generate a starter hoststack.yaml
  ${cyan('validate')}    Validate your hoststack.yaml config

${bold('OTHER')}
  ${cyan('help')}        Show this help message
  ${cyan('version')}     Show CLI version

${bold('EXAMPLES')}
  hoststack login --key hs_live_abc123
  hoststack projects list
  hoststack services list
  hoststack deploy trigger <service-id>
  hoststack logs <service-id>
  hoststack db create --project prj_abc --name app-db --engine postgres
  hoststack db link db_abc --service svc_xyz     ${dim('# injects DATABASE_URL')}
  hoststack db connect <database-id>
  hoststack dns zones                            ${dim('# and whether the registry points here')}
  hoststack dns check example.com
  hoststack dns add example.com A www 203.0.113.10 --ttl 300
  hoststack dev create --project prj_abc
  hoststack machines list
  hoststack errors list --service 48
  hoststack errors fix 12                        ${dim('# hand it to an agent in the dev box')}
  hoststack alerts --since -6h                   ${dim('# what broke this afternoon')}
  hoststack alerts channels add --type slack --name ops --url https://... --events all
  hoststack activity --type deploy --since -2h
  hoststack services metrics svc_xyz             ${dim('# and the host it sits on')}
  hoststack deploy diagnose svc_xyz dpl_abc      ${dim('# record + build log + runtime log')}
  hoststack deploy promote svc_stg dpl_abc --to env_prod
  hoststack db query db_abc "SELECT count(*) FROM users"
  hoststack task add --project prj_abc --box svc_xyz "Fix the footprint join"
  hoststack uptime set 48 --path /healthz --every 60
  hoststack analytics stats --range 30d          ${dim('# every site, one table')}
  hoststack machines add desktop                 ${dim('# prints the installer to run on it')}
  hoststack services create --name api --type web --project prj_abc --machine desktop
  hoststack infra release plan 15 --commit <sha>  ${dim('# needs HOSTSTACK_INFRA_OPERATOR_TOKEN')}
  hoststack init
  hoststack validate

${bold('ENVIRONMENT')}
  HOSTSTACK_API_KEY     API key (overrides config file)
  HOSTSTACK_API_URL     API base URL (overrides config file)
  HOSTSTACK_TEAM_ID     Team ID (overrides config file)
  HOSTSTACK_INFRA_OPERATOR_TOKEN  Token for ${cyan('hoststack infra')} (never saved to the config file)

${dim(`Config: ~/.hoststack/config.json`)}
`);
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);

	switch (command) {
		case 'login':
			await loginCommand(args);
			break;
		case 'whoami':
			await whoamiCommand();
			break;
		case 'projects':
		case 'project':
			await projectsCommand(args);
			break;
		case 'services':
		case 'service':
			await servicesCommand(args);
			break;
		case 'deploy':
		case 'deploys':
			await deployCommand(args);
			break;
		case 'logs':
		case 'log':
			await logsCommand(args);
			break;
		case 'env':
			await envCommand(args);
			break;
		case 'environments':
		case 'environment':
		case 'envs':
			await environmentsCommand(args);
			break;
		case 'db':
		case 'database':
		case 'databases':
			await dbCommand(args);
			break;
		case 'domains':
		case 'domain':
			await domainsCommand(args);
			break;
		case 'dns':
			await dnsCommand(args);
			break;
		case 'volumes':
		case 'volume':
		case 'disks':
		case 'disk':
			await volumesCommand(args);
			break;
		case 'cron':
			await cronCommand(args);
			break;
		case 'task':
		case 'tasks':
			await taskCommand(args);
			break;
		case 'errors':
		case 'error':
			await errorsCommand(args);
			break;
		case 'alerts':
		case 'alert':
			await alertsCommand(args);
			break;
		case 'activity':
		case 'audit':
			await activityCommand(args);
			break;
		case 'report':
			await reportCommand(args);
			break;
		case 'analytics':
			await analyticsCommand(args);
			break;
		case 'uptime':
			await uptimeCommand(args);
			break;
		case 'github':
			await githubCommand(args);
			break;
		case 'dev':
			await devCommand(args);
			break;
		case 'machines':
		case 'machine':
			await machinesCommand(args);
			break;
		case 'infra':
			await infraCommand(args);
			break;
		case 'init':
			await initCommand(args);
			break;
		case 'validate':
			await validateCommand(args);
			break;
		case 'help':
		case '--help':
		case '-h':
		case undefined:
			printHelp();
			break;
		case 'version':
		case '--version':
		case '-v':
			console.log(`hoststack v${VERSION}`);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			console.error(`Run ${cyan('hoststack help')} for usage info.`);
			process.exit(1);
	}
}

main();
