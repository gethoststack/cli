import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bold, cyan, dim, green, red, yellow } from '../lib/output.ts';

/**
 * Simple YAML parser for hoststack.yaml config files.
 * Handles the limited subset our config uses.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = content.split('\n');
	const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
		{ indent: -1, obj: result },
	];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === '' || line.trim().startsWith('#')) continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();

		while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1]!.obj;

		if (trimmed.startsWith('- ')) {
			const value = trimmed.slice(2).trim();
			const lastKey = Object.keys(parent).pop();
			if (lastKey && Array.isArray(parent[lastKey])) {
				(parent[lastKey] as unknown[]).push(parseValue(value));
			}
			continue;
		}

		const colonIdx = trimmed.indexOf(':');
		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const rawValue = trimmed.slice(colonIdx + 1).trim();

		if (rawValue === '' || rawValue === '|' || rawValue === '>') {
			const nextLine = lines[i + 1];
			if (nextLine && nextLine.trim().startsWith('- ')) {
				parent[key] = [];
			} else {
				const nested: Record<string, unknown> = {};
				parent[key] = nested;
				stack.push({ indent, obj: nested });
			}
		} else {
			parent[key] = parseValue(rawValue);
		}
	}

	return result;
}

function parseValue(raw: string): string | number | boolean {
	const commentIdx = raw.indexOf(' #');
	const value = commentIdx >= 0 ? raw.slice(0, commentIdx).trim() : raw;
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	if (value === 'true') return true;
	if (value === 'false') return false;
	const num = Number(value);
	if (!Number.isNaN(num) && value !== '') return num;
	return value;
}

// Inline validation (matches shared schema logic but without importing Zod in CLI)
const VALID_SERVICE_TYPES = ['web_service', 'worker', 'cron_job', 'static_site'];
const VALID_DB_ENGINES = ['postgres', 'redis'];

interface ValidationError {
	path: string;
	message: string;
}

function validate(config: Record<string, unknown>): ValidationError[] {
	const errors: ValidationError[] = [];

	if (config.services !== undefined) {
		if (typeof config.services !== 'object' || config.services === null) {
			errors.push({ path: 'services', message: 'Must be an object' });
		} else {
			for (const [name, svc] of Object.entries(
				config.services as Record<string, Record<string, unknown>>,
			)) {
				const prefix = `services.${name}`;
				if (typeof svc !== 'object' || svc === null) {
					errors.push({ path: prefix, message: 'Must be an object' });
					continue;
				}
				if (svc.type && !VALID_SERVICE_TYPES.includes(svc.type as string)) {
					errors.push({
						path: `${prefix}.type`,
						message: `Invalid type "${svc.type}". Must be one of: ${VALID_SERVICE_TYPES.join(', ')}`,
					});
				}
				if (svc.port !== undefined && (typeof svc.port !== 'number' || svc.port < 1)) {
					errors.push({
						path: `${prefix}.port`,
						message: 'Must be a positive number',
					});
				}
				if (svc.scaling && typeof svc.scaling === 'object') {
					const scaling = svc.scaling as Record<string, unknown>;
					if (
						scaling.min !== undefined &&
						(typeof scaling.min !== 'number' || scaling.min < 1)
					) {
						errors.push({ path: `${prefix}.scaling.min`, message: 'Must be >= 1' });
					}
					if (
						scaling.max !== undefined &&
						(typeof scaling.max !== 'number' || scaling.max < 1)
					) {
						errors.push({ path: `${prefix}.scaling.max`, message: 'Must be >= 1' });
					}
					if (
						typeof scaling.min === 'number' &&
						typeof scaling.max === 'number' &&
						scaling.min > scaling.max
					) {
						errors.push({
							path: `${prefix}.scaling`,
							message: 'min cannot be greater than max',
						});
					}
				}
			}
		}
	}

	if (config.databases !== undefined) {
		if (typeof config.databases !== 'object' || config.databases === null) {
			errors.push({ path: 'databases', message: 'Must be an object' });
		} else {
			for (const [name, db] of Object.entries(
				config.databases as Record<string, Record<string, unknown>>,
			)) {
				const prefix = `databases.${name}`;
				if (typeof db !== 'object' || db === null) {
					errors.push({ path: prefix, message: 'Must be an object' });
					continue;
				}
				if (!db.engine) {
					errors.push({ path: `${prefix}.engine`, message: 'Required field' });
				} else if (!VALID_DB_ENGINES.includes(db.engine as string)) {
					errors.push({
						path: `${prefix}.engine`,
						message: `Invalid engine "${db.engine}". Must be one of: ${VALID_DB_ENGINES.join(', ')}`,
					});
				}
			}
		}
	}

	return errors;
}

export async function validateCommand(_args: string[]): Promise<void> {
	const dir = process.cwd();

	// Find config file
	let filePath: string | null = null;
	let filename = '';
	for (const candidate of ['hoststack.yaml', 'hoststack.yml']) {
		const p = join(dir, candidate);
		if (existsSync(p)) {
			filePath = p;
			filename = candidate;
			break;
		}
	}

	if (!filePath) {
		console.error(`${red('Error:')} No ${bold('hoststack.yaml')} found in current directory.`);
		console.error(`Run ${cyan('hoststack init')} to create one.`);
		process.exit(1);
	}

	console.log(`${dim('Validating')} ${bold(filename)}${dim('...')}`);

	// Read and parse
	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch {
		console.error(`${red('Error:')} Could not read ${filename}`);
		process.exit(1);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseSimpleYaml(content);
	} catch (err) {
		console.error(
			`${red('Error:')} Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}

	// Validate
	const errors = validate(parsed);

	if (errors.length === 0) {
		console.log(`${green('+')} ${bold(filename)} is valid`);

		// Print summary
		const services = parsed.services
			? Object.keys(parsed.services as Record<string, unknown>)
			: [];
		const databases = parsed.databases
			? Object.keys(parsed.databases as Record<string, unknown>)
			: [];

		if (services.length > 0) {
			console.log(`  Services: ${services.map((s) => cyan(s)).join(', ')}`);
		}
		if (databases.length > 0) {
			console.log(`  Databases: ${databases.map((d) => cyan(d)).join(', ')}`);
		}
	} else {
		console.error(`${red('Error:')} Found ${errors.length} issue(s):`);
		console.error();
		for (const err of errors) {
			console.error(`  ${yellow(err.path)}: ${err.message}`);
		}
		process.exit(1);
	}
}
