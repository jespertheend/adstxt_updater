/**
 * @typedef TransformAdsTxtOptions
 * @property {boolean | string[]} [strip_variables]
 */

/**
 * @param {string} content The adstxt to transform
 * @param {TransformAdsTxtOptions} options
 */
export function transformAdsTxt(content, {
	strip_variables = false,
} = {}) {
	if (strip_variables) {
		const removeVariables = Array.isArray(strip_variables) ? strip_variables : [];
		content = stripVariables(content, removeVariables);
	}
	return content;
}

/**
 * Removes all or some variable declratations from adstxt content
 * @param {string} content The adstxt to transform
 * @param {string[]} removeVariables The keys of the variables to remove, pass an empty array to remove all variables.
 */
function stripVariables(content, removeVariables) {
	const lines = content.split("\n");
	const filteredLines = lines.filter((line) => {
		if (line.startsWith("#")) return true;
		const match = line.match(/^(?<key>\S+)\s?=/);
		if (!match) return true;
		if (removeVariables.length == 0) return false;
		if (!match.groups?.key) return true;
		if (removeVariables.includes(match.groups.key)) return false;
		return true;
	});
	return filteredLines.join("\n");
}
