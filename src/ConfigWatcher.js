import * as yaml from "$std/encoding/yaml.ts";
import { SingleInstancePromise } from "./SingleInstancePromise.js";
import { AdsTxtUpdater } from "./AdsTxtUpdater.js";
import { logger } from "./logger.js";

/**
 * An AdsTxtUpdater is responsible for updating exactly one ads.txt using exactly one configuration file.
 * It watches the configuration file for changes and updates the ads.txt when needed.
 * It also watches the destination for changes and overwrites it when another application modifies it.
 */
export class ConfigWatcher {
	#absoluteConfigPath;
	#loadConfigInstance;
	/** @type {Deno.FsWatcher?} */
	#configWatcher = null;
	/** @type {Set<AdsTxtUpdater>} */
	#updaters = new Set();
	/** @type {Set<Promise<void>>} */
	#destructedUpdaterPromises = new Set();
	#destructed = false;

	/**
	 * @param {string} absoluteConfigPath
	 * @param {import("./AdsTxtCache.js").AdsTxtCache} adsTxtCache
	 */
	constructor(absoluteConfigPath, adsTxtCache) {
		this.#absoluteConfigPath = absoluteConfigPath;

		this.#loadConfigInstance = new SingleInstancePromise(async () => {
			if (this.#destructed) return;
			const content = await Deno.readTextFile(this.#absoluteConfigPath);
			let parsed = yaml.parse(content, {
				filename: this.#absoluteConfigPath,
			});

			for (const updater of this.#updaters) {
				const promise = updater.destructor();
				this.#destructedUpdaterPromises.add(promise);
			}
			this.#updaters.clear();

			if (!Array.isArray(parsed)) {
				parsed = [parsed];
			}
			const configs = /** @type {import("./AdsTxtUpdater.js").AdsTxtConfig[]} */ (parsed);
			for (const config of configs) {
				const updater = new AdsTxtUpdater(this.#absoluteConfigPath, config, adsTxtCache);
				this.#updaters.add(updater);
			}

			logger.info(`Loaded configuration at ${this.#absoluteConfigPath}`);
		});
		this.#loadConfigInstance.run();

		this.#watchConfig();
	}

	/**
	 * Waits for existing promises to resolve and then cleans up any created watchers.
	 */
	async destructor() {
		if (this.#destructed) {
			throw new Error("Updater is already destructed");
		}
		this.#destructed = true;

		await this.waitForPromises();

		this.#configWatcher?.close();
	}

	/**
	 * Mostly meant for tests, allows you to wait for all pending promises that are related to this updater to be resolved.
	 */
	waitForPromises() {
		/** @type {Promise<void>[]} */
		const promises = [];
		promises.push(this.#loadConfigInstance.waitForFinishIfRunning());
		for (const updater of this.#updaters) {
			promises.push(updater.waitForPromises());
		}
		promises.push(...this.#destructedUpdaterPromises);
		return Promise.all(promises);
	}

	/**
	 * Watch the config file for changes
	 */
	async #watchConfig() {
		this.#configWatcher = Deno.watchFs(this.#absoluteConfigPath);
		for await (const e of this.#configWatcher) {
			if (e.kind != "access") {
				logger.info("Configuration changed, reloading...");
				this.#loadConfigInstance.run();
			}
		}
	}
}
