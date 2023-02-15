/**
 * @typedef FetchAdsTxtResult
 * @property {boolean} fresh
 * @property {string} content
 */

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
	 * @param {number} cacheDurationMs Duration in milliseconds for which no new requests will be made.
	 * @returns {Promise<FetchAdsTxtResult>}
	 */
	async fetchAdsTxt(url, cacheDurationMs = 60 * 60 * 1000) {
		let existing = this.#cachedAdsTxts.get(url);
		let fresh = (existing || false) && Date.now() - existing.fetchTime < cacheDurationMs;
		if (!fresh) {
			const fetchTime = Date.now();
			let response;
			try {
				response = await fetch(url);
			} catch (e) {
				if (e instanceof TypeError) {
					// If a network error occurs we don't want to throw and just return a cached value instead.
				} else {
					throw e;
				}
			}
			if (response && response.ok) {
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
