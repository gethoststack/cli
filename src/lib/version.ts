/**
 * Package version, injected at build time by tsup's `define`
 * (`__CLI_VERSION__` ← package.json `version`). The `declare` keeps the source
 * typecheckable without a build; the `?? '0.0.0-dev'` fallback keeps the
 * un-bundled source (tests, ts-node) working when the define is absent.
 */
declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
	typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';

/** User-Agent sent on every CLI request, e.g. `hoststack-cli/0.8.0`. */
export const USER_AGENT = `hoststack-cli/${CLI_VERSION}`;
