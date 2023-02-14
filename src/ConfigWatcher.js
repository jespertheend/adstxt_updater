import * as yaml from "$std/encoding/yaml.ts";
import { SingleInstancePromise } from "./SingleInstancePromise.js";

/**
 * @typedef AdsTxtConfig
 * @property {string} destination
 * @property {string[]} sources
 */

export class ConfigWatcher {
	absoluteConfigPath;
	/** @type {AdsTxtConfig?} */
	#loadedConfig;
	#loadInstance;
	/** @type {Deno.FsWatcher?} */
	#destinationWatcher = null;

	/**
	 * @param {string} absoluteConfigPath
	 */
	constructor(absoluteConfigPath) {
		this.absoluteConfigPath = absoluteConfigPath;
		this.#loadedConfig = null;

		this.#loadInstance = new SingleInstancePromise(async () => {
			const content = await Deno.readTextFile(this.absoluteConfigPath);
			const parsed = yaml.parse(content, {
				filename: this.absoluteConfigPath,
			});
			this.#loadedConfig = /** @type {AdsTxtConfig} */ (parsed);
			this.#reloadDestinationWatcher();
		});
		this.#loadInstance.run();
		this.#watchConfig();
	}

	/**
	 * Watch the config file for changes
	 */
	async #watchConfig() {
		for await (const e of Deno.watchFs(this.absoluteConfigPath)) {
			if (e.kind != "access") {
				this.#loadInstance.run();
			}
		}
	}

	async #reloadDestinationWatcher() {
		if (!this.#loadedConfig) {
			throw new Error("Assertion failed, no config loaded");
		}
		if (this.#destinationWatcher) {
			this.#destinationWatcher.close();
			this.#destinationWatcher = null;
		}
		try {
			this.#destinationWatcher = Deno.watchFs(this.#loadedConfig.destination);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) {

			}
		}
		for await (const e of this.#destinationWatcher) {
			console.log(e);
		}
	}
}
