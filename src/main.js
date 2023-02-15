import * as path from "$std/path/mod.ts";
import { AdsTxtCache } from "./AdsTxtCache.js";
import { AdsTxtUpdater } from "./AdsTxtUpdater.js";

/**
 * @param {string[]} paths
 */
export function run(paths) {
	const cache = new AdsTxtCache();

	/** @type {AdsTxtUpdater[]} */
	const configLoaders = [];
	for (const arg of paths) {
		const configPath = path.resolve(arg);
		const loader = new AdsTxtUpdater(configPath, cache);
		configLoaders.push(loader);
	}
}

if (import.meta.main) {
	run(Deno.args);
}
