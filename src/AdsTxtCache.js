/**
 * Caches previously fetched ads.txt urls and allows you to fetch ads.txts with a set cache duration.
 * If the request fails, or the cache is still fresh enough, an old cached value will be returned.
 */
export class AdsTxtCache {
	/**
	 * @typedef CachedAdsTxt
	 * @property {string} content
	 * @property {number} fetchTime Time at which the content was requested.
	 */
	/** @type {Map<string, CachedAdsTxt>} */
	#cachedAdsTxts = new Map();

	/**
	 * @param {string} url The url to fetch from.
	 * @param {number} cacheDurationSeconds Duration in seconds for which no new requests will be made.
	 */
	async fetchAdsTxt(url, cacheDurationSeconds = 60 * 60 * 1000) {
		let existing = this.#cachedAdsTxts.get(url);
		let fresh = existing && Date.now() - existing.fetchTime < cacheDurationSeconds;
		if (!fresh) {
			const fetchTime = Date.now();
			const response = await fetch(url);
			if (response.ok) {
				const content = await response.text();
				existing = {
					fetchTime,
					content,
				};
				fresh = true;
				this.#cachedAdsTxts.set(url, existing);
			}
		}
		if (!existing) {
			throw new Error(`Failed to fetch "${url}" and no existing content was found in the cache.`);
		}
		return {
			fresh,
			content: existing.content,
		};
	}
}
