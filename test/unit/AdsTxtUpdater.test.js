import { FakeTime } from "$std/testing/time.ts";
import { assertEquals } from "$std/testing/asserts.ts";
import { AdsTxtUpdater, mockEnsureFile } from "../../src/AdsTxtUpdater.js";
import { createMockAdsTxtCache, mockDate, stubFsCalls } from "./shared.js";

mockEnsureFile();

/**
 * @typedef AdsTxtUpdaterTestContext
 * @property {AdsTxtUpdater} updater
 * @property {FakeTime} time
 * @property {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} fetchResults
 * @property {Map<string, string>} fileContents
 * @property {(path: string, content: string?, event: Deno.FsEvent) => void} externalUpdateFileContent
 */
/**
 * @param {Object} options
 * @param {import("../../src/AdsTxtUpdater.js").AdsTxtConfig} options.config
 * @param {(ctx: AdsTxtUpdaterTestContext) => void | Promise<void>} options.fn
 * @param {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} [options.fetchAdsTxtResults]
 */
async function basicTest({
	config,
	fetchAdsTxtResults,
	fn,
}) {
	const { mockCache, fetchResults } = createMockAdsTxtCache(fetchAdsTxtResults);
	const time = new FakeTime();
	const mockedDate = mockDate();
	const { fileContents, externalUpdateFileContent, restore } = stubFsCalls();

	try {
		const updater = new AdsTxtUpdater("/path/to/config.yml", config, mockCache);

		// Wait for ads.txt to get written
		await updater.waitForPromises();

		try {
			await fn({ updater, time, fetchResults, fileContents, externalUpdateFileContent });
		} finally {
			await updater.destructor();
		}
	} finally {
		restore();
		time.restore();
		mockedDate.restore();
	}
}

/**
 * @param {string?} intervalStr
 * @param {number} firstTickMs
 * @param {number} secondTickMs
 */
async function intervalTest(intervalStr, firstTickMs, secondTickMs) {
	/** @type {import("../../src/AdsTxtUpdater.js").AdsTxtConfig} */
	const config = {
		destination: "/ads.txt",
		sources: ["https://example/ads1.txt"],
	};
	if (intervalStr != null) {
		config.updateInterval = intervalStr;
	}
	await basicTest({
		config,
		async fn({ updater, fileContents, time, fetchResults }) {
			fetchResults.set("https://example/ads1.txt", {
				content: "content2",
				fresh: true,
			});
			await time.tickAsync(firstTickMs);
			// Wait for ads.txt to potentially get written
			await updater.waitForPromises();

			assertEquals(
				fileContents.get("/ads.txt"),
				`# This file was generated on *current time*

# Fetched from https://example/ads1.txt
content1

`,
			);

			fetchResults.set("https://example/ads1.txt", {
				content: "content2",
				fresh: true,
			});
			await time.tickAsync(secondTickMs);

			// Wait for ads.txt to get written
			await updater.waitForPromises();

			assertEquals(
				fileContents.get("/ads.txt"),
				`# This file was generated on *current time*

# Fetched from https://example/ads1.txt
content2

`,
			);
		},
	});
}

Deno.test({
	name: "periodically updates the ads.txt",
	async fn() {
		await intervalTest("3s", 1_000, 5_000);
		await intervalTest("60s", 55_000, 65_000);
		await intervalTest("2m", 115_000, 125_000);
		const twoHours = 1000 * 60 * 60 * 2;
		await intervalTest("2h", twoHours - 5_000, twoHours + 5_000);
		const twoDays = 1000 * 60 * 60 * 24 * 2;
		await intervalTest("2d", twoDays - 5_000, twoDays + 5_000);

		// Defaults to one day when not set
		const oneDay = 1000 * 60 * 60 * 24;
		await intervalTest(null, oneDay - 5_000, oneDay + 5_000);
		await intervalTest("", oneDay - 5_000, oneDay + 5_000);
	},
});

Deno.test({
	name: "Transforms results",
	async fn() {
		/** @type {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} */
		const fetchAdsTxtResults = new Map();
		fetchAdsTxtResults.set("https://example/ads1.txt", {
			fresh: true,
			content: `
# comment
VARIABLE=removed
OTHER_VARIABLE=not removed
domain.com, 1234, RESELLER, 123456789abcdef1
`,
		});
		await basicTest({
			config: {
				destination: "/ads.txt",
				sources: [
					{
						source: "https://example/ads1.txt",
						transform: {
							strip_variables: ["VARIABLE"],
						},
					},
				],
			},
			fetchAdsTxtResults,
			fn({ fileContents }) {
				assertEquals(
					fileContents.get("/ads.txt"),
					`# This file was generated on *current time*

# Fetched from https://example/ads1.txt

# comment
OTHER_VARIABLE=not removed
domain.com, 1234, RESELLER, 123456789abcdef1


`,
				);
			},
		});
	},
});

Deno.test({
	name: "Rewrites destination when it is changed",
	ignore: true,
	async fn() {
		await basicTest({
			config: {
				destination: "/path/to/ads.txt",
				sources: ["https://example/ads1.txt"],
			},
			async fn({ updater, fileContents, externalUpdateFileContent }) {
				function assertAdsTxtContent() {
					assertEquals(
						fileContents.get("/path/to/ads.txt"),
						`# This file was generated on *current time*

# Fetched from https://example/ads1.txt
content1

`,
					);
				}
				assertAdsTxtContent();

				externalUpdateFileContent("/path/to/ads.txt", "rewritten", {
					kind: "modify",
					paths: ["/path/to/ads.txt"],
				});

				// Wait for fetch and write, not sure why we need to wait a third time.
				await updater.waitForPromises();
				await updater.waitForPromises();
				await updater.waitForPromises();

				assertAdsTxtContent();
			},
		});
	},
});

Deno.test({
	name: "Rewrites destination when the parent is deleted",
	ignore: true,
	async fn() {
		await basicTest({
			config: {
				destination: "/path/to/ads.txt",
				sources: ["https://example/ads1.txt"],
			},
			async fn({ updater, fileContents, externalUpdateFileContent }) {
				function assertAdsTxtContent() {
					assertEquals(
						fileContents.get("/path/to/ads.txt"),
						`# This file was generated on *current time*

# Fetched from https://example/ads1.txt
content1

`,
					);
				}
				assertAdsTxtContent();

				externalUpdateFileContent("/path/to/ads.txt", null, {
					kind: "remove",
					paths: ["/path/to"],
				});

				// Wait for fetch and write, not sure why we need to wait a third time.
				await updater.waitForPromises();
				await updater.waitForPromises();
				await updater.waitForPromises();

				assertAdsTxtContent();
			},
		});
	},
});
