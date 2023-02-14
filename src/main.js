import * as path from "$std/path/mod.ts";
import { ConfigWatcher } from "./ConfigWatcher.js";

/**
 * @param {string[]} paths
 */
export function run(paths) {
	/** @type {ConfigWatcher[]} */
	const configLoaders = [];
	for (const arg of paths) {
		const configPath = path.resolve(arg);
		const loader = new ConfigWatcher(configPath);
		configLoaders.push(loader);
	}
}

if (import.meta.main) {
	run(Deno.args);
}
