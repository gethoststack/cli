import { cronCommand } from './commands/cron.ts';
import { dbCommand } from './commands/db.ts';
import { deployCommand } from './commands/deploy.ts';
import { domainsCommand } from './commands/domains.ts';
import { envCommand } from './commands/env.ts';
import { initCommand } from './commands/init.ts';
import { loginCommand } from './commands/login.ts';
import { logsCommand } from './commands/logs.ts';
import { projectsCommand } from './commands/projects.ts';
import { servicesCommand } from './commands/services.ts';
import { validateCommand } from './commands/validate.ts';
import { whoamiCommand } from './commands/whoami.ts';
import { bold, cyan, dim } from './lib/output.ts';

const VERSION = '0.1.0';

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
  ${cyan('db')}          Manage databases (Postgres, Redis)
  ${cyan('env')}         Manage environment variables
  ${cyan('cron')}        Manage cron job executions

${bold('OPERATIONS')}
  ${cyan('deploy')}      Trigger and manage deployments
  ${cyan('logs')}        View runtime logs for a service

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
  hoststack env set <service-id> DATABASE_URL=postgres://...
  hoststack db connect <database-id>
  hoststack init
  hoststack validate

${bold('ENVIRONMENT')}
  HOSTSTACK_API_KEY     API key (overrides config file)
  HOSTSTACK_API_URL     API base URL (overrides config file)
  HOSTSTACK_TEAM_ID     Team ID (overrides config file)

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
		case 'db':
		case 'database':
		case 'databases':
			await dbCommand(args);
			break;
		case 'domains':
		case 'domain':
			await domainsCommand(args);
			break;
		case 'cron':
			await cronCommand(args);
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
