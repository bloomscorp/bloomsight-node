/** Filled in at build time from package.json (tsup.config.ts); 'dev' in tests run from source. */
declare const __BLOOMSIGHT_NODE_VERSION__: string;

export const VERSION: string =
	typeof __BLOOMSIGHT_NODE_VERSION__ === 'string' ? __BLOOMSIGHT_NODE_VERSION__ : 'dev';
