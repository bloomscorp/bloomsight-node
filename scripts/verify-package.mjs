// The packaging gate: what `npm publish` would ship loads, in both module systems,
// and carries no source, tests or secrets.
import {execSync} from 'node:child_process';
import {createRequire} from 'node:module';

const fail = (msg) => { console.error(`verify-package: ${msg}`); process.exit(1); };

const packed = JSON.parse(execSync('npm pack --dry-run --json', {encoding: 'utf8'}))[0];
const files = packed.files.map(f => f.path).sort();
const allowed = ['LICENSE.md', 'README.md', 'dist/index.d.mts', 'dist/index.d.ts', 'dist/index.js', 'dist/index.mjs', 'package.json'];
const extra = files.filter(f => !allowed.includes(f));
const missing = allowed.filter(f => !files.includes(f));
if (extra.length) fail(`unexpected files in the package: ${extra.join(', ')}`);
if (missing.length) fail(`missing from the package: ${missing.join(', ')}`);

const require = createRequire(import.meta.url);
const cjs = require('../dist/index.js');
const esm = await import('../dist/index.mjs');
for (const [name, mod] of [['cjs', cjs], ['esm', esm]]) {
	if (typeof mod.Bloomsight !== 'function' || typeof mod.BloomsightError !== 'function') fail(`${name} build does not export Bloomsight and BloomsightError`);
	if (mod.VERSION !== JSON.parse(execSync('node -p "JSON.stringify(require(\'./package.json\').version)"', {encoding: 'utf8'}))) fail(`${name} VERSION does not match package.json`);
}
console.log(`verify-package: ok (${files.length} files, cjs + esm load, version ${cjs.VERSION})`);
