import * as path from "$std/path/mod.ts";
import * as fs from "$std/fs/mod.ts";
import * as yaml from "$std/encoding/yaml.ts";
import { handlers, Logger } from "$std/log/mod.ts";
import { SingleInstancePromise } from "./SingleInstancePromise.js";

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
	#loadInstance;
	#updateAdsTxtInstance;
	/** @type {Deno.FsWatcher?} */
	#destinationWatcher = null;
	#logger = new Logger("AdsTxtUpdager", "INFO", {
		handlers: [
			new handlers.ConsoleHandler("INFO", {
				formatter: "{msg}",
			}),
		],
	});

	/**
	 * @param {string} absoluteConfigPath
	 * @param {import("./AdsTxtCache.js").AdsTxtCache} adsTxtCache
	 */
	constructor(absoluteConfigPath, adsTxtCache) {
		this.#absoluteConfigPath = absoluteConfigPath;
		this.#adsTxtCache = adsTxtCache;
		this.#loadedConfig = null;

		this.#loadInstance = new SingleInstancePromise(async () => {
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
			// this.#reloadDestinationWatcher();
		});
		this.#loadInstance.run();

		this.#updateAdsTxtInstance = new SingleInstancePromise(async () => {
			if (!this.#absoluteDestinationPath) {
				throw new Error("Assertion failed, no absoluteDestinationPath has been set");
			}
			this.#logger.info(`Fetching required content for ${this.#absoluteDestinationPath}`);
			const content = await this.#getAdsTxtsContent();
			await fs.ensureFile(this.#absoluteDestinationPath);
			await Deno.writeTextFile(this.#absoluteDestinationPath, content);
			this.#logger.info(`Updated ${this.#absoluteDestinationPath}`);
		});

		this.#watchConfig();
	}

	/**
	 * Watch the config file for changes
	 */
	async #watchConfig() {
		for await (const e of Deno.watchFs(this.#absoluteConfigPath)) {
			if (e.kind != "access") {
				this.#logger.info("Configuration changed, reloading...");
				this.#loadInstance.run();
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
				console.log(e);
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
			for (const url of failedUrls) {
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
