import { describe, expect, test } from 'bun:test';

import {
	bold,
	cyan,
	dim,
	green,
	red,
	statusBadge,
	table,
	yellow,
} from '../lib/output.ts';

describe('ANSI color helpers', () => {
	test.each([
		['bold', bold, '\x1b[1m'],
		['dim', dim, '\x1b[2m'],
		['green', green, '\x1b[32m'],
		['red', red, '\x1b[31m'],
		['yellow', yellow, '\x1b[33m'],
		['cyan', cyan, '\x1b[36m'],
	] as const)('%s wraps text with ANSI codes', (_name, fn, prefix) => {
		const out = fn('hi');
		expect(out.startsWith(prefix)).toBe(true);
		expect(out.endsWith('\x1b[0m')).toBe(true);
		expect(out).toContain('hi');
	});
});

describe('table formatter', () => {
	test('renders headers + rows with column padding', () => {
		const out = table(['Name', 'Status'], [
			['web', 'running'],
			['worker', 'stopped'],
		]);
		const lines = out.split('\n');
		expect(lines).toHaveLength(4); // headers + separator + 2 rows
		expect(lines[0]).toContain('Name');
		expect(lines[0]).toContain('Status');
		expect(lines[2]).toContain('web');
		expect(lines[3]).toContain('worker');
	});

	test('handles missing cells gracefully', () => {
		const out = table(['A', 'B'], [['just-a']]);
		expect(out).toContain('just-a');
	});
});

describe('statusBadge', () => {
	test('success-family statuses are green', () => {
		expect(statusBadge('running')).toContain('\x1b[32m');
		expect(statusBadge('active')).toContain('\x1b[32m');
		expect(statusBadge('deployed')).toContain('\x1b[32m');
	});

	test('failure-family statuses are red', () => {
		expect(statusBadge('failed')).toContain('\x1b[31m');
		expect(statusBadge('error')).toContain('\x1b[31m');
		expect(statusBadge('suspended')).toContain('\x1b[31m');
	});

	test('pending-family statuses are yellow', () => {
		expect(statusBadge('building')).toContain('\x1b[33m');
		expect(statusBadge('pending')).toContain('\x1b[33m');
	});

	test('unknown statuses are returned plain', () => {
		expect(statusBadge('quantum-fluctuating')).toBe('quantum-fluctuating');
	});
});
