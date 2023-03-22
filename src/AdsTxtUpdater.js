import * as path from "$std/path/mod.ts";
import * as fs from "$std/fs/mod.ts";
import { SingleInstancePromise } from "./SingleInstancePromise.js";
import { logger } from "./logger.js";
import { transformAdsTxt } from "./transformAdsTxt.js";

let ensureFile = fs.ensureFile;
export function mockEnsureFile() {
	ensureFile = async () => {};
}

/**
 * @typedef AdsTxtSourceConfig
 * @property {string} source
 * @property {import("./transformAdsTxt.js").TransformAdsTxtOptions} [transform]
 */

/**
 * @typedef AdsTxtConfig
 * @property {string} [updateInterval]
 * @property {string} destination
 * @property {(AdsTxtSourceConfig | string)[]} sources
 */

/**
 * An AdsTxtUpdater is responsible for updating exactly one ads.txt.
 * It fetches and updates the ads.txt once a day.
 * And it watches the destination for changes and overwrites it when another application modifies it.
 */
export class AdsTxtUpdater {
	#absoluteDestinationPath;
	#config;
	#adsTxtCache;
	#absoluteWatchDestinationPath;
	/** @type {Deno.FsWatcher?} */
	#destinationWatcher = null;
	#updateAdsTxtInstance;
	#updateIntervalId = 0;
	#destructed = false;

	/**
	 * @param {string} absoluteConfigPath
	 * @param {AdsTxtConfig} config
	 * @param {import("./AdsTxtCache.js").AdsTxtCache} adsTxtCache
	 */
	constructor(absoluteConfigPath, config, adsTxtCache) {
		const absoluteDestinationPath = path.resolve(
			path.dirname(absoluteConfigPath),
			config.destination,
		);

		this.#absoluteDestinationPath = absoluteDestinationPath;
		this.#config = config;
		this.#adsTxtCache = adsTxtCache;

		// We watch the parent directory, rather than the destination file itself.
		// This gives us two advantages:
		// - The path is less likely to not exist, meaning we can start watching right away
		// - This allows the user to delete the parent directory without losing the ads.txt
		//   Since the ads.txt is in the root of a site, this essentially allows the user to
		//   delete and reupload the entire site at once.
		this.#absoluteWatchDestinationPath = path.dirname(absoluteDestinationPath);

		this.#updateAdsTxtInstance = new SingleInstancePromise(async () => {
			if (this.#destructed) return;
			if (!this.#absoluteDestinationPath) {
				throw new Error("Assertion failed, no absoluteDestinationPath has been set");
			}
			logger.info(`Fetching required content for ${this.#absoluteDestinationPath}`);
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
				logger.info(`Updated ${this.#absoluteDestinationPath}`);
				this.#reloadDestinationWatcher(true);
			}
		});
		this.#updateAdsTxtInstance.run();
		this.#reloadDestinationWatcher();

		let interval = 24 * 60 * 60 * 1000;
		const intervalStr = config.updateInterval || "24h";
		const match = intervalStr.match(/(?<amount>\d+)(?<unit>[smhd])/);
		if (match && match.groups) {
			let amount = parseInt(match.groups.amount, 10);
			if (match.groups.unit == "s") {
				amount *= 1000;
			} else if (match.groups.unit == "m") {
				amount *= 60 * 1000;
			} else if (match.groups.unit == "h") {
				amount *= 60 * 60 * 1000;
			} else if (match.groups.unit == "d") {
				amount *= 24 * 60 * 60 * 1000;
			}
			if (isFinite(amount)) {
				interval = amount;
			}
		}

		this.#updateIntervalId = setInterval(() => {
			this.#updateAdsTxtInstance.run();
		}, interval);
	}

	async destructor() {
		if (this.#destructed) {
			throw new Error("Updater is already destructed");
		}
		this.#destructed = true;

		await this.waitForPromises();

		this.#destinationWatcher?.close();
		clearInterval(this.#updateIntervalId);
	}

	/**
	 * Mostly meant for tests, allows you to wait for all pending promises that are related to this updater to be resolved.
	 */
	waitForPromises() {
		return this.#updateAdsTxtInstance.waitForFinishIfRunning();
	}

	/**
	 * @param {boolean} onlyWhenNotSet When true, only updates the watcher when no watcher exists yet.
	 */
	async #reloadDestinationWatcher(onlyWhenNotSet = false) {
		if (!this.#absoluteWatchDestinationPath || !this.#absoluteDestinationPath) {
			throw new Error("Assertion failed, no absoluteDestinationPath has been set");
		}
		if (onlyWhenNotSet && this.#destinationWatcher) return;
		if (this.#destinationWatcher) {
			this.#destinationWatcher.close();
			this.#destinationWatcher = null;
		}
		try {
			this.#destinationWatcher = Deno.watchFs(this.#absoluteWatchDestinationPath);
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
					let needsUpdate = false;
					for (const path of e.paths) {
						if (this.#absoluteWatchDestinationPath == path || this.#absoluteDestinationPath == path) {
							needsUpdate = true;
							break;
						}
					}
					if (needsUpdate) {
						this.#updateAdsTxtInstance.run();
					}
				}
			}
		}
	}

	/**
	 * Fetches all sources and returns the generated string for the ads.txt.
	 * The string includes errors and warnings for failed requests.
	 */
	async #getAdsTxtsContent() {
		if (!this.#config) {
			throw new Error("Assertion failed, no config is currently loaded");
		}
		if (this.#config.sources.length == 0) {
			return "# Warning: The configuration file contains no sources urls.\n";
		}

		const promises = [];
		for (const sourceConfig of this.#config.sources) {
			/** @type {AdsTxtSourceConfig} */
			let config;
			if (typeof sourceConfig != "string") {
				config = sourceConfig;
			} else {
				config = {
					source: sourceConfig,
				};
			}
			const promise = (async () => {
				let result;
				let error;
				try {
					result = await this.#adsTxtCache.fetchAdsTxt(config.source);
				} catch (e) {
					error = e;
				}
				if (result && config.transform) {
					result.content = transformAdsTxt(result.content, config.transform);
				}
				return {
					url: config.source,
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

		let content = `# This file was generated on ${new Date().toUTCString()}\n\n`;
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
			content += `# Fetched from ${result.url}\n`;
			content += result.content;
			content += "\n\n";
		}
		return content;
	}
}
