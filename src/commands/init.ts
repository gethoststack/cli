import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bold, cyan, green, red, yellow } from '../lib/output.ts';

const TEMPLATE = `# HostStack Configuration
# Docs: https://hoststack.dev/docs/yaml-config

services:
  web:
    type: web_service
    start:
      command: npm start
    port: 3000
    healthCheck:
      path: /health
      interval: 10
      timeout: 5
    scaling:
      min: 1
      max: 1
    # env:
    #   NODE_ENV: production
    # domains:
    #   - myapp.com
    # build:
    #   command: npm run build

# databases:
#   db:
#     engine: postgres
#     version: "16"
#     plan: starter
#   cache:
#     engine: redis
#     version: "7"
`;

export async function initCommand(args: string[]): Promise<void> {
	const dir = process.cwd();
	const filename = 'hoststack.yaml';
	const filePath = join(dir, filename);

	// Check for existing file
	if (existsSync(filePath) || existsSync(join(dir, 'hoststack.yml'))) {
		if (!args.includes('--force')) {
			console.error(`${yellow('!')} ${bold(filename)} already exists in this directory.`);
			console.error(`  Use ${cyan('hoststack init --force')} to overwrite.`);
			process.exit(1);
		}
	}

	writeFileSync(filePath, TEMPLATE, 'utf-8');
	console.log(`${green('+')} Created ${bold(filename)}`);
	console.log();
	console.log(`Edit the file to configure your services, then run:`);
	console.log(`  ${cyan('hoststack validate')}  — check for errors`);
	console.log(`  ${cyan('hoststack deploy')}    — deploy your service`);
}
