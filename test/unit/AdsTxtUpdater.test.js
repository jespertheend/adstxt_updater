import { stub } from "$std/testing/mock.ts";
import { assertEquals, AssertionError } from "$std/testing/asserts.ts";
import { AdsTxtUpdater, mockEnsureFile } from "../../src/AdsTxtUpdater.js";

mockEnsureFile();

/**
 * @typedef AdsTxtUpdaterTestContext
 * @property {AdsTxtUpdater} updater
 * @property {() => string?} getCurrentDestinationContent
 */
/**
 * @param {Object} options
 * @param {(ctx: AdsTxtUpdaterTestContext) => Promise<void>} options.fn
 * @param {string} options.destinationPath The path to the ads.txt destination file
 * @param {string} options.configContent
 * @param {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} [options.fetchAdsTxtResults]
 */
async function basicTest({
	fn,
	destinationPath,
	configContent,
	fetchAdsTxtResults = new Map(),
}) {
	const configPath = "/config.yml";
	/** @type {string?} */
	let currentDestinationContent = null;

	const readTextFileSpy = stub(Deno, "readTextFile", async (path) => {
		if (path == configPath) {
			return configContent;
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
	const watchFsSpy = stub(Deno, "watchFs", (path) => {
		const watcher = {
			close() {},
			[Symbol.asyncIterator]() {
				return {
					next() {
						return new Promise((r) => {});
					},
				};
			},
		};
		return /** @type {Deno.FsWatcher} */ (watcher);
	});

	const mockCache = /** @type {import("../../src/AdsTxtCache.js").AdsTxtCache} */ ({
		async fetchAdsTxt(url, _durationSeconds) {
			const result = fetchAdsTxtResults.get(url);
			if (!result) {
				throw new Error(`Failed to fetch "${url}" and no existing content was found in the cache.`);
			}
			return result;
		},
	});

	try {
		const updater = new AdsTxtUpdater(configPath, mockCache);
		await fn({
			updater,
			getCurrentDestinationContent() {
				return currentDestinationContent;
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
			async fn({ updater, getCurrentDestinationContent }) {
				// Wait for config to load
				await updater.waitForPromises();
				// Wait for ads.txt to get written
				await updater.waitForPromises();
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
