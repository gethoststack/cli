import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Inject the real package version at build time so `hoststack --version` and the
// User-Agent (`hoststack-cli/<version>`) match what's published, instead of
// hand-edited constants that drift from package.json.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
	version: string;
};

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	clean: true,
	target: 'node18',
	platform: 'node',
	sourcemap: false,
	splitting: false,
	banner: { js: '#!/usr/bin/env node' },
	define: {
		__CLI_VERSION__: JSON.stringify(pkg.version),
	},
});
