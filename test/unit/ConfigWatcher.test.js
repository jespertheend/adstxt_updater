import { assertEquals } from "$std/testing/asserts.ts";
import { ConfigWatcher } from "../../src/ConfigWatcher.js";
import { mockEnsureFile } from "../../src/AdsTxtUpdater.js";
import { createMockAdsTxtCache, stubFsCalls } from "./shared.js";

mockEnsureFile();

/**
 * @typedef ConfigWatcherTestContext
 * @property {ConfigWatcher} watcher
 * @property {string} configPath
 * @property {() => string?} getCurrentDestinationContent
 * @property {(newContent: string, event: Deno.FsEvent) => void} udpateConfig
 * @property {(newContent: string, event: Deno.FsEvent) => void} udpateDestination
 */
/**
 * @param {Object} options
 * @param {(ctx: ConfigWatcherTestContext) => Promise<void>} options.fn
 * @param {string} [options.destinationPath] The path to the ads.txt destination file
 * @param {string?} [options.configContent]
 * @param {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} [options.fetchAdsTxtResults]
 */
async function basicTest({
	fn,
	destinationPath = "/ads.txt",
	configContent = null,
	fetchAdsTxtResults,
}) {
	const configPath = "/config.yml";

	if (configContent == null) {
		configContent = `
destination: ${destinationPath}
sources:
  - https://example/ads1.txt
`;
	}

	const { fileContents, externalUpdateFileContent, restore } = stubFsCalls();
	fileContents.set(configPath, configContent);

	const { mockCache } = createMockAdsTxtCache(fetchAdsTxtResults);

	try {
		const watcher = new ConfigWatcher(configPath, mockCache);

		// Wait for config to load
		await watcher.waitForPromises();
		// Wait for ads.txt to get written
		await watcher.waitForPromises();

		await fn({
			watcher,
			configPath,
			getCurrentDestinationContent() {
				return fileContents.get(destinationPath) || null;
			},
			udpateConfig(newContent, event) {
				externalUpdateFileContent(configPath, newContent, event);
			},
			udpateDestination(newContent, event) {
				externalUpdateFileContent(destinationPath, newContent, event);
			},
		});

		await watcher.destructor();
	} finally {
		restore();
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
			async fn({ watcher, configPath, getCurrentDestinationContent, udpateConfig }) {
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
				await watcher.waitForPromises();
				// Wait for ads.txt to get written
				await watcher.waitForPromises();
				// Wait a third time, not sure why
				await watcher.waitForPromises();

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
			async fn({ watcher, udpateDestination, getCurrentDestinationContent }) {
				udpateDestination("replaced content", {
					kind: "modify",
					paths: [destinationPath],
				});

				assertEquals(getCurrentDestinationContent(), "replaced content");

				// Wait for config to load
				await watcher.waitForPromises();
				// Wait for ads.txt to get written
				await watcher.waitForPromises();
				// Wait a third time, not sure why
				await watcher.waitForPromises();

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
