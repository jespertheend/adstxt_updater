import { stub } from "$std/testing/mock.ts";
import { assertEquals, AssertionError } from "$std/testing/asserts.ts";
import { ConfigWatcher } from "../../src/ConfigWatcher.js";
import { mockEnsureFile } from "../../src/AdsTxtUpdater.js";

mockEnsureFile();

/**
 * @typedef AdsTxtUpdaterTestContext
 * @property {ConfigWatcher} updater
 * @property {string} configPath
 * @property {() => string?} getCurrentDestinationContent
 * @property {(newContent: string, event: Deno.FsEvent) => void} udpateConfig
 * @property {(newContent: string, event: Deno.FsEvent) => void} udpateDestination
 */
/**
 * @param {Object} options
 * @param {(ctx: AdsTxtUpdaterTestContext) => Promise<void>} options.fn
 * @param {string} [options.destinationPath] The path to the ads.txt destination file
 * @param {string} [options.destinationWatchPath] The path that the updater is expected to watch
 * @param {string?} [options.configContent]
 * @param {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} [options.fetchAdsTxtResults]
 */
async function basicTest({
	fn,
	destinationPath = "/ads.txt",
	destinationWatchPath = "/",
	configContent = null,
	fetchAdsTxtResults,
}) {
	const configPath = "/config.yml";
	/** @type {string?} */
	let currentDestinationContent = null;

	if (configContent == null) {
		configContent = `
destination: ${destinationPath}
sources:
  - https://example/ads1.txt
`;
	}

	if (!fetchAdsTxtResults) {
		fetchAdsTxtResults = new Map();
		fetchAdsTxtResults.set("https://example/ads1.txt", {
			content: "content1",
			fresh: true,
		});
		fetchAdsTxtResults.set("https://example/ads2.txt", {
			content: "content2",
			fresh: true,
		});
	}

	const readTextFileSpy = stub(Deno, "readTextFile", async (path) => {
		if (path == configPath) {
			if (configContent != null) {
				return configContent;
			}
		} else if (path == destinationPath && currentDestinationContent != null) {
			return currentDestinationContent;
		}
		throw new Deno.errors.NotFound(`Path at ${path} does not exist`);
	});
	const writeTextFileSpy = stub(Deno, "writeTextFile", async (path, content) => {
		if (path == destinationPath) {
			if (typeof content != "string") {
				throw new AssertionError("Writing a ReadableStream is not supported in this test");
			}
			currentDestinationContent = content;
		} else {
			throw new AssertionError(
				`Text was written to an unexpected destination. Expected "${destinationPath}" but got "${path}"`,
			);
		}
	});
	/** @type {Set<(e: Deno.FsEvent) => void>} */
	const configWatchEventCbs = new Set();
	/** @type {Set<(e: Deno.FsEvent) => void>} */
	const destinationWatchEventCbs = new Set();
	const watchFsSpy = stub(Deno, "watchFs", (path) => {
		/** @type {Set<(e: Deno.FsEvent) => void>} */
		let cbsSet;
		if (path == configPath && configContent != null) {
			cbsSet = configWatchEventCbs;
		} else if (path == destinationWatchPath) {
			cbsSet = destinationWatchEventCbs;
		} else {
			throw new Deno.errors.NotFound(`Path at ${path} does not exist`);
		}
		const watcher = {
			close() {},
			[Symbol.asyncIterator]() {
				return {
					async next() {
						const result = await new Promise((r) => {
							cbsSet.add(r);
						});
						return {
							value: result,
							done: false,
						};
					},
				};
			},
		};
		return /** @type {Deno.FsWatcher} */ (watcher);
	});

	const fetchAdsTxtResultsCertain = fetchAdsTxtResults;
	const mockCache = /** @type {import("../../src/AdsTxtCache.js").AdsTxtCache} */ ({
		fetchAdsTxt(url, _durationSeconds) {
			const result = fetchAdsTxtResultsCertain.get(url);
			if (!result) {
				throw new Error(`Failed to fetch "${url}" and no existing content was found in the cache.`);
			}
			return Promise.resolve(result);
		},
	});

	try {
		const updater = new ConfigWatcher(configPath, mockCache);

		// Wait for config to load
		await updater.waitForPromises();
		// Wait for ads.txt to get written
		await updater.waitForPromises();

		await fn({
			updater,
			configPath,
			getCurrentDestinationContent() {
				return currentDestinationContent;
			},
			udpateConfig(newContent, event) {
				configContent = newContent;
				const cbs = [...configWatchEventCbs];
				configWatchEventCbs.clear();
				cbs.forEach((cb) => cb(event));
			},
			udpateDestination(newContent, event) {
				currentDestinationContent = newContent;
				const cbs = [...destinationWatchEventCbs];
				destinationWatchEventCbs.clear();
				cbs.forEach((cb) => cb(event));
			},
		});

		await updater.destructor();
	} finally {
		readTextFileSpy.restore();
		writeTextFileSpy.restore();
		watchFsSpy.restore();
	}
}

Deno.test({
	name: "Loads the config and updates the destination file",
	async fn() {
		/** @type {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} */
		const fetchAdsTxtResults = new Map();
		fetchAdsTxtResults.set("https://example/ads1.txt", {
			content: "content1",
			fresh: true,
		});
		fetchAdsTxtResults.set("https://example/ads2.txt", {
			content: "content2",
			fresh: false,
		});
		const destinationPath = "/ads.txt";
		const configContent = `
destination: ${destinationPath}
sources:
  - https://example/ads1.txt
  - https://example/ads2.txt
  - https://example/ads3.txt
`;
		await basicTest({
			fetchAdsTxtResults,
			destinationPath,
			configContent,
			async fn({ getCurrentDestinationContent }) {
				const content = getCurrentDestinationContent();
				assertEquals(
					content,
					`# Error: The following urls failed and are not included:
# - https://example/ads3.txt

# Warning: The following urls failed, but were cached and are still included:
# - https://example/ads2.txt


# Fetched from https://example/ads1.txt
content1

# Fetched from https://example/ads2.txt
content2
`,
				);
			},
		});
	},
});

Deno.test({
	name: "Fetches again when the config changes",
	async fn() {
		const destinationPath = "/ads.txt";

		await basicTest({
			destinationPath,
			async fn({ updater, configPath, getCurrentDestinationContent, udpateConfig }) {
				udpateConfig(
					`
destination: ${destinationPath}
sources:
  - https://example/ads2.txt`,
					{
						kind: "modify",
						paths: [configPath],
					},
				);

				// Wait for config to load
				await updater.waitForPromises();
				// Wait for ads.txt to get written
				await updater.waitForPromises();
				// Wait a third time, not sure why
				await updater.waitForPromises();

				const content2 = getCurrentDestinationContent();
				assertEquals(
					content2,
					`
# Fetched from https://example/ads2.txt
content2
`,
				);
			},
		});
	},
});

Deno.test({
	name: "Rewrites the destination when it is changed from an external source",
	async fn() {
		const destinationPath = "/ads.txt";
		await basicTest({
			destinationPath,
			async fn({ updater, udpateDestination, getCurrentDestinationContent }) {
				udpateDestination("replaced content", {
					kind: "modify",
					paths: [destinationPath],
				});

				assertEquals(getCurrentDestinationContent(), "replaced content");

				// Wait for config to load
				await updater.waitForPromises();
				// Wait for ads.txt to get written
				await updater.waitForPromises();
				// Wait a third time, not sure why
				await updater.waitForPromises();

				const content2 = getCurrentDestinationContent();
				assertEquals(
					content2,
					`
# Fetched from https://example/ads1.txt
content1
`,
				);
			},
		});
	},
});
