import * as path from "$std/path/mod.ts";
import * as fs from "$std/fs/mod.ts";
import * as yaml from "$std/encoding/yaml.ts";
import { handlers, Logger } from "$std/log/mod.ts";
import { SingleInstancePromise } from "./SingleInstancePromise.js";

let ensureFile = fs.ensureFile;
export function mockEnsureFile() {
	ensureFile = async () => {};
}

/**
 * @typedef AdsTxtConfig
 * @property {string} destination
 * @property {string[]} sources
 */

/**
 * An AdsTxtUpdater is responsible for updating exactly one ads.txt using exactly one configuration file.
 * It watches the configuration file for changes and updates the ads.txt when needed.
 * It also watches the destination for changes and overwrites it when another application modifies it.
 */
export class AdsTxtUpdater {
	#absoluteConfigPath;
	#adsTxtCache;
	/** @type {AdsTxtConfig?} */
	#loadedConfig;
	/** @type {string?} */
	#absoluteDestinationPath = null;
	#loadConfigInstance;
	#updateAdsTxtInstance;
	/** @type {Deno.FsWatcher?} */
	#destinationWatcher = null;
	/** @type {Deno.FsWatcher?} */
	#configWatcher = null;
	#logger = new Logger("AdsTxtUpdager", "INFO", {
		handlers: [
			new handlers.ConsoleHandler("INFO", {
				formatter: "{msg}",
			}),
		],
	});
	#destructed = false;

	/**
	 * @param {string} absoluteConfigPath
	 * @param {import("./AdsTxtCache.js").AdsTxtCache} adsTxtCache
	 */
	constructor(absoluteConfigPath, adsTxtCache) {
		this.#absoluteConfigPath = absoluteConfigPath;
		this.#adsTxtCache = adsTxtCache;
		this.#loadedConfig = null;

		this.#loadConfigInstance = new SingleInstancePromise(async () => {
			if (this.#destructed) return;
			const content = await Deno.readTextFile(this.#absoluteConfigPath);
			const parsed = yaml.parse(content, {
				filename: this.#absoluteConfigPath,
			});
			this.#loadedConfig = /** @type {AdsTxtConfig} */ (parsed);
			this.#absoluteDestinationPath = path.resolve(
				path.dirname(this.#absoluteConfigPath),
				this.#loadedConfig.destination,
			);
			this.#logger.info(`Loaded configuration at ${this.#absoluteConfigPath}`);
			this.#updateAdsTxtInstance.run();
			this.#reloadDestinationWatcher();
		});
		this.#loadConfigInstance.run();

		this.#updateAdsTxtInstance = new SingleInstancePromise(async () => {
			if (this.#destructed) return;
			if (!this.#absoluteDestinationPath) {
				throw new Error("Assertion failed, no absoluteDestinationPath has been set");
			}
			this.#logger.info(`Fetching required content for ${this.#absoluteDestinationPath}`);
			const desiredContent = await this.#getAdsTxtsContent();
			let currentContent = null;
			try {
				currentContent = await Deno.readTextFile(this.#absoluteDestinationPath);
			} catch (e) {
				if (!(e instanceof Deno.errors.NotFound)) {
					throw e;
				}
			}
			if (currentContent != desiredContent) {
				await ensureFile(this.#absoluteDestinationPath);
				await Deno.writeTextFile(this.#absoluteDestinationPath, desiredContent);
				this.#logger.info(`Updated ${this.#absoluteDestinationPath}`);
			}
		});

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
		this.#destinationWatcher?.close();
	}

	/**
	 * Mostly meant for tests, allows you to wait for all pending promises that are related to this updater to be resolved.
	 */
	waitForPromises() {
		return Promise.all([
			this.#loadConfigInstance.waitForFinishIfRunning(),
			this.#updateAdsTxtInstance.waitForFinishIfRunning(),
		]);
	}

	/**
	 * Watch the config file for changes
	 */
	async #watchConfig() {
		this.#configWatcher = Deno.watchFs(this.#absoluteConfigPath);
		for await (const e of this.#configWatcher) {
			if (e.kind != "access") {
				this.#logger.info("Configuration changed, reloading...");
				this.#loadConfigInstance.run();
			}
		}
	}

	async #reloadDestinationWatcher() {
		if (!this.#absoluteDestinationPath) {
			throw new Error("Assertion failed, no absoluteDestinationPath has been set");
		}
		if (this.#destinationWatcher) {
			this.#destinationWatcher.close();
			this.#destinationWatcher = null;
		}
		try {
			this.#destinationWatcher = Deno.watchFs(this.#absoluteDestinationPath);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) {
				// We'll retry once we have added the file ourselves
			} else {
				throw e;
			}
		}
		if (this.#destinationWatcher) {
			for await (const e of this.#destinationWatcher) {
				if (e.kind != "access") {
					this.#updateAdsTxtInstance.run();
				}
			}
		}
	}

	/**
	 * Fetches all sources and returns the generated string for the ads.txt.
	 * The string includes errors and warnings for failed requests.
	 */
	async #getAdsTxtsContent() {
		if (!this.#loadedConfig) {
			throw new Error("Assertion failed, no config is currently loaded");
		}
		if (this.#loadedConfig.sources.length == 0) {
			return "# Warning: The configuration file contains no sources urls.\n";
		}

		const promises = [];
		for (const url of this.#loadedConfig.sources) {
			const promise = (async () => {
				let result;
				let error;
				try {
					result = await this.#adsTxtCache.fetchAdsTxt(url);
				} catch (e) {
					error = e;
				}
				return {
					url,
					result,
					error,
				};
			})();
			promises.push(promise);
		}
		const results = await Promise.all(promises);
		const failedUrls = [];
		const failedButCachedUrls = [];
		const successfulResults = [];
		for (const result of results) {
			if (result.result) {
				successfulResults.push({
					url: result.url,
					content: result.result.content,
				});
				if (!result.result.fresh) {
					failedButCachedUrls.push(result.url);
				}
			} else if (result.error) {
				failedUrls.push(result.url);
			}
		}

		let content = "";
		if (failedUrls.length > 0) {
			content += "# Error: The following urls failed and are not included:\n";
			for (const url of failedUrls) {
				content += `# - ${url}`;
			}
			content += "\n\n";
		}

		if (failedButCachedUrls.length > 0) {
			content += "# Warning: The following urls failed, but were cached and are still included:\n";
			for (const url of failedButCachedUrls) {
				content += `# - ${url}`;
			}
			content += "\n\n";
		}

		for (const result of successfulResults) {
			content += `\n# Fetched from ${result.url}\n`;
			content += result.content;
			content += "\n";
		}
		return content;
	}
}
