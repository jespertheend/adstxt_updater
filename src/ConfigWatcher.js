import * as yaml from "$std/encoding/yaml.ts";
import { SingleInstancePromise } from "./SingleInstancePromise.js";
import { AdsTxtUpdater } from "./AdsTxtUpdater.js";
import { logger } from "./logger.js";

/**
 * A ConfigWatcher is responsible for updating the ads.txt files configured in exactly one configuration file.
 * It watches the configuration file for changes and updates the ads.txt when needed.
 * AdsTxtUpdaters are created for every destination path in the config file.
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

		for (const updater of this.#updaters) {
			await updater.destructor();
		}
		this.#updaters.clear();

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
