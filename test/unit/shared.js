import { AssertionError } from "$std/testing/asserts.ts";
import { stub } from "$std/testing/mock.ts";

/**
 * @param {Map<string, import("../../src/AdsTxtCache.js").FetchAdsTxtResult>} [fetchResults]
 */
export function createMockAdsTxtCache(fetchResults) {
	if (!fetchResults) {
		fetchResults = new Map();
		fetchResults.set("https://example/ads1.txt", {
			content: "content1",
			fresh: true,
		});
		fetchResults.set("https://example/ads2.txt", {
			content: "content2",
			fresh: true,
		});
	}

	const fetchResultsCertain = fetchResults;
	const mockCache = /** @type {import("../../src/AdsTxtCache.js").AdsTxtCache} */ ({
		fetchAdsTxt(url, _durationSeconds) {
			const result = fetchResultsCertain.get(url);
			if (!result) {
				throw new Error(`Failed to fetch "${url}" and no existing content was found in the cache.`);
			}
			return Promise.resolve(result);
		},
	});

	return { mockCache, fetchResults: fetchResultsCertain };
}

export function stubFsCalls() {
	/** @type {Map<string, string>} */
	const fileContents = new Map();
	const readTextFileSpy = stub(Deno, "readTextFile", async (path) => {
		if (typeof path != "string") {
			throw new Error("Only string paths are supported");
		}
		const content = fileContents.get(path);
		if (content !== undefined) {
			return content;
		}
		throw new Deno.errors.NotFound(`Path at ${path} does not exist`);
	});

	const writeTextFileSpy = stub(Deno, "writeTextFile", async (path, content) => {
		if (typeof path != "string") {
			throw new Error("Only string paths are supported");
		}
		if (typeof content != "string") {
			throw new AssertionError("Writing a ReadableStream is not supported in this test");
		}
		fileContents.set(path, content);
	});

	/** @type {Map<string, Set<(e: Deno.FsEvent) => void>>} */
	const watchEventCbs = new Map();
	const watchFsSpy = stub(Deno, "watchFs", (path) => {
		if (typeof path != "string") {
			throw new Error("Only string paths are supported");
		}
		let found = false;
		for (const filePath of fileContents.keys()) {
			if (filePath.startsWith(path)) {
				found = true;
				break;
			}
		}
		if (!found) {
			throw new Deno.errors.NotFound(`Path at ${path} does not exist`);
		}
		let cbsSet = watchEventCbs.get(path);
		if (!cbsSet) {
			cbsSet = new Set();
			watchEventCbs.set(path, cbsSet);
		}
		const cbs = cbsSet;
		const watcher = {
			close() {},
			[Symbol.asyncIterator]() {
				return {
					async next() {
						const result = await new Promise((r) => {
							cbs.add(r);
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

	return {
		readTextFileSpy,
		fileContents,
		/**
		 * @param {string} path
		 * @param {string} content
		 * @param {Deno.FsEvent} event
		 */
		externalUpdateFileContent(path, content, event) {
			fileContents.set(path, content);
			for (const [cbsPath, cbs] of watchEventCbs) {
				if (path.startsWith(cbsPath)) {
					const cbsArr = [...cbs];
					cbs.clear();
					cbsArr.forEach((cb) => cb(event));
				}
			}
		},
		restore() {
			readTextFileSpy.restore();
			writeTextFileSpy.restore();
			watchFsSpy.restore();
		},
	};
}
