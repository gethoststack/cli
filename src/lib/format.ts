/**
 * Number and date rendering for CLI output.
 *
 * The locale is PINNED rather than inherited. `toLocaleString()` with no
 * argument formats in whatever locale the machine is set to, so the same
 * command printed "1.762 pageviews" on a Danish laptop and "1,762" on an
 * American one — from the same build, in output people paste into tickets and
 * compare against the dashboard, which pins the same locale (`APP_LOCALE` in
 * `@hoststack/shared`). A CLI whose numbers change shape with `LANG` is one
 * whose output cannot be quoted.
 *
 * Copied rather than imported: this package publishes to npm and
 * `@hoststack/shared` is `private: true`, so anything the bundle reaches
 * cannot come from it — the same rule the volume and machine types are
 * restated under. `output.test.ts` guards the copy against drift.
 */
const CLI_LOCALE = 'en-IE';

const COUNT_FORMAT = new Intl.NumberFormat(CLI_LOCALE);

/** A plain count with thousands separators, e.g. 1762 → "1,762". */
export function formatCount(value: number): string {
	return COUNT_FORMAT.format(value);
}

/**
 * A timestamp in the machine's own zone, e.g. "7 Sept 2026, 15:30".
 *
 * The zone is deliberately NOT pinned, unlike the locale: a terminal is
 * running where its operator is, and printing UTC to somebody reading their
 * own machine's clock is how a "started 2 minutes ago" reads as two hours.
 */
export function formatDateTime(value: string | Date | null | undefined, fallback = 'n/a'): string {
	const date = toDate(value);
	if (date === null) return fallback;
	return date.toLocaleString(CLI_LOCALE, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/** A date with no time of day, e.g. "7 Sept 2026". */
export function formatDate(value: string | Date | null | undefined, fallback = 'n/a'): string {
	const date = toDate(value);
	if (date === null) return fallback;
	return date.toLocaleDateString(CLI_LOCALE, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

/** Null, undefined and unparseable all mean "no reading", never 1 Jan 1970. */
function toDate(value: string | Date | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}
