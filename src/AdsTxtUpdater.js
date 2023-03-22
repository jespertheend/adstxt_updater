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
	/** @type {Set<Deno.FsWatcher>} */
	#watchers = new Set();
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
				this.#reloadWatchers();
			}
		});
		this.#updateAdsTxtInstance.run();
		this.#reloadWatchers();

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

		this.#closeWatchers();
		clearInterval(this.#updateIntervalId);
	}

	/**
	 * Mostly meant for tests, allows you to wait for all pending promises that are related to this updater to be resolved.
	 */
	waitForPromises() {
		return this.#updateAdsTxtInstance.waitForFinishIfRunning();
	}

	#closeWatchers() {
		for (const watcher of this.#watchers) {
			watcher.close();
		}
		this.#watchers.clear();
	}

	async #reloadWatchers() {
		if (!this.#absoluteDestinationPath) {
			throw new Error("Assertion failed, no absoluteDestinationPath has been set");
		}
		// There's an issue that causes events to not get reported when a lot of events happen at once:
		// https://github.com/denoland/deno/issues/11373
		// Which might be very common if the user is deleting and reuploading the entire site.
		// So instead of watching the full directory, we only watch the destination file itself.
		// We also watch all parent directories (non recursively), in case the file or one of its
		// parents doesn't exist yet.

		/** @type {Set<string>} */
		const paths = new Set();
		let lastPath = this.#absoluteDestinationPath;
		paths.add(lastPath);
		while (true) {
			lastPath = path.resolve(lastPath, "..");
			if (paths.has(lastPath)) break;
			paths.add(lastPath);
		}

		this.#closeWatchers();
		for (const path of paths) {
			this.#createWatcher(path);
		}
	}

	/**
	 * @param {string} path
	 */
	async #createWatcher(path) {
		let watcher;
		try {
			watcher = Deno.watchFs(path, {
				recursive: false,
			});
			this.#watchers.add(watcher);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) {
				// We'll retry once we have added the file ourselves
				return;
			} else {
				throw e;
			}
		}

		for await (const e of watcher) {
			if (e.kind == "access") continue;

			// I'm not sure why, but for some reason the `paths` property is frequently a different
			// path from the one we have set the watcher to, even though the watcher was created with `recursive`
			// https://github.com/denoland/deno/issues/18348
			// To work around this we check if the reported path is the same as the one we provided to the watcher.
			if (!e.paths.includes(path)) continue;

			this.#updateAdsTxtInstance.run();
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
