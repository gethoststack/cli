import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	clean: true,
	target: 'node18',
	platform: 'node',
	sourcemap: false,
	splitting: false,
	banner: { js: '#!/usr/bin/env node' },
});
