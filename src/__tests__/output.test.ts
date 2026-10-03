import { beforeAll, describe, expect, test } from 'bun:test';

import { formatCount, formatDate, formatDateTime } from '../lib/format.ts';
import { bold, cyan, dim, green, red, statusBadge, table, yellow } from '../lib/output.ts';

// The test runner's stdout is not a TTY, and color is now suppressed off-TTY
// (so ANSI never leaks into pipes / files). Force color on to exercise the
// wrapping logic deterministically — this is the same `FORCE_COLOR=1` escape
// hatch real users get when piping to a color-aware pager.
beforeAll(() => {
	process.env.FORCE_COLOR = '1';
});

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
		const out = table(
			['Name', 'Status'],
			[
				['web', 'running'],
				['worker', 'stopped'],
			],
		);
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

// --- format.ts ---
//
// The CLI pins its locale instead of inheriting the machine's: `LANG` deciding
// whether a count prints "1,762" or "1.762" makes the output impossible to
// quote, and puts the CLI at odds with the dashboard for the same number.

describe('formatCount', () => {
	test('separates thousands, and not the way a Danish machine would', () => {
		expect(formatCount(1762)).toBe('1,762');
		expect(formatCount(1762)).not.toBe((1762).toLocaleString('da-DK'));
	});
});

describe('formatDateTime / formatDate', () => {
	test('a missing timestamp is "n/a", never 1 Jan 1970', () => {
		// `new Date(null)` is the epoch, not an invalid date, so the nullable
		// columns these render (finishedAt, lastHeartbeatAt, expiresAt) used to
		// need a ternary at every call site to avoid printing 1970.
		expect(formatDateTime(null)).toBe('n/a');
		expect(formatDate(undefined)).toBe('n/a');
		expect(formatDateTime('not a timestamp')).toBe('n/a');
	});

	test('keeps a 24-hour clock', () => {
		expect(formatDateTime('2026-09-07T15:30:00Z')).toMatch(/\d{2}:\d{2}/);
		expect(formatDateTime('2026-09-07T15:30:00Z')).not.toMatch(/[AP]M/);
	});

	test('a plain date carries no time of day', () => {
		expect(formatDate('2026-09-07T15:30:00Z')).not.toMatch(/\d{2}:\d{2}/);
		expect(formatDate('2026-09-07T15:30:00Z')).toContain('2026');
	});
});
