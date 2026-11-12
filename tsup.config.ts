import {defineConfig} from 'tsup';
import {readFileSync} from 'fs';

const {version} = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
	entry: ['./src/index.ts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	target: 'node18',
	platform: 'node',
	define: {__BLOOMSIGHT_NODE_VERSION__: JSON.stringify(version)},
});
