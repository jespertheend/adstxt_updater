import * as path from "$std/path/mod.ts";
import { AdsTxtCache } from "./AdsTxtCache.js";
import { ConfigWatcher } from "./ConfigWatcher.js";

/**
 * @param {string[]} paths
 */
export function run(paths) {
	const cache = new AdsTxtCache();

	/** @type {ConfigWatcher[]} */
	const configLoaders = [];
	for (const arg of paths) {
		const configPath = path.resolve(arg);
		const loader = new ConfigWatcher(configPath, cache);
		configLoaders.push(loader);
	}
}

if (import.meta.main) {
	if (Deno.args.length == 0) {
		console.log(
			"No configuration files have been provided, provide one or more paths to configuration files via the arguments.",
		);
		Deno.exit();
	} else {
		run(Deno.args);
	}
}
