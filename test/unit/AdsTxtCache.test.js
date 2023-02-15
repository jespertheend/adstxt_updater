import { assertSpyCall, assertSpyCalls, returnsNext, stub } from "$std/testing/mock.ts";
import { FakeTime } from "$std/testing/time.ts";
import { assertEquals, assertRejects } from "$std/testing/asserts.ts";
import { AdsTxtCache } from "../../src/AdsTxtCache.js";

Deno.test({
	name: "Properly caches content",
	async fn() {
		const fetchSpy = stub(
			globalThis,
			"fetch",
			returnsNext([
				Promise.resolve(new Response("content1")),
				Promise.resolve(new Response("content2")),
				Promise.resolve(
					new Response("Not found", {
						status: 404,
					}),
				),
				Promise.resolve(new Response("content3")),
			]),
		);
		const time = new FakeTime();

		try {
			const cache = new AdsTxtCache();
			const result1 = await cache.fetchAdsTxt("https://example.com/ads.txt", 60_000);
			assertEquals(result1, {
				fresh: true,
				content: "content1",
			});
			assertSpyCalls(fetchSpy, 1);
			assertSpyCall(fetchSpy, 0, {
				args: ["https://example.com/ads.txt"],
			});

			time.tick(30_000);
			const result2 = await cache.fetchAdsTxt("https://example.com/ads.txt", 60_000);
			assertEquals(result2, {
				fresh: true,
				content: "content1",
			});
			assertSpyCalls(fetchSpy, 1);

			time.tick(40_000);
			const result3 = await cache.fetchAdsTxt("https://example.com/ads.txt", 60_000);
			assertEquals(result3, {
				fresh: true,
				content: "content2",
			});
			assertSpyCalls(fetchSpy, 2);

			time.tick(70_000);
			const result4 = await cache.fetchAdsTxt("https://example.com/ads.txt", 60_000);
			assertEquals(result4, {
				fresh: false,
				content: "content2",
			});
			assertSpyCalls(fetchSpy, 3);

			time.tick(1_000);
			const result5 = await cache.fetchAdsTxt("https://example.com/ads.txt", 60_000);
			assertEquals(result5, {
				fresh: true,
				content: "content3",
			});
			assertSpyCalls(fetchSpy, 4);
		} finally {
			fetchSpy.restore();
			time.restore();
		}
	},
});

Deno.test({
	name: "Failing request from the start",
	async fn() {
		const fetchSpy = stub(
			globalThis,
			"fetch",
			returnsNext([
				Promise.resolve(
					new Response("Not found", {
						status: 404,
					}),
				),
			]),
		);

		try {
			const cache = new AdsTxtCache();
			await assertRejects(async () => {
				await cache.fetchAdsTxt("https://example.com/ads.txt", 60_000);
			});
		} finally {
			fetchSpy.restore();
		}
	},
});
