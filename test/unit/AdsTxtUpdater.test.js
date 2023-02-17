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
 */
/**
 * @param {Object} options
 * @param {import("../../src/AdsTxtUpdater.js").AdsTxtConfig} options.config
 * @param {(ctx: AdsTxtUpdaterTestContext) => void | Promise<void>} options.fn
 */
async function basicTest({
	config,
	fn,
}) {
	const { mockCache, fetchResults } = createMockAdsTxtCache();
	const time = new FakeTime();
	const mockedDate = mockDate();
	const { fileContents, restore } = stubFsCalls();

	try {
		const updater = new AdsTxtUpdater("/path/to/config.yml", config, mockCache);

		// Wait for ads.txt to get written
		await updater.waitForPromises();

		try {
			await fn({ updater, time, fetchResults, fileContents });
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
 * @param {string} intervalStr
 * @param {number} firstTickMs
 * @param {number} secondTickMs
 */
async function intervalTest(intervalStr, firstTickMs, secondTickMs) {
	await basicTest({
		config: {
			updateInterval: intervalStr,
			destination: "/ads.txt",
			sources: ["https://example/ads1.txt"],
		},
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
	},
});
