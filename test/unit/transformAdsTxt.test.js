import { assertEquals } from "$std/testing/asserts.ts";
import { transformAdsTxt } from "../../src/transformAdsTxt.js";

Deno.test({
	name: "Empty options object shouldn't make any changes",
	fn() {
		const contents = [
			"",
			"# comment",
			"#comment",
			"###comment",
			"#####",
			"variable = value",
			"VARIABLE = value",
			"variable=value",
			"VARIABLE=value",
			"domain.com, 1234, RESELLER, 123456789abcdef1",
			"domain.com,1234,RESELLER,123456789abcdef1",
			`#multi
# line
#comment
VARIABLE=value
domain.com, 1234, RESELLER, 123456789abcdef1
#another comment`,
		];

		for (const content of contents) {
			const newContent = transformAdsTxt(content);
			assertEquals(newContent, content);
		}
	},
});

Deno.test({
	name: "strip all variables",
	fn() {
		const content = transformAdsTxt(
			`
# comment
#comment
domain.com, 1234, RESELLER, 123456789abcdef1
domain.com,1234,RESELLER,123456789abcdef1
VARIABLE=value
not removed=value
var = value
variable = domain.com, 1234, RESELLER, 123456789abcdef1
domain.com, 1234, RESELLER, 123456789abcdef1
`,
			{
				strip_variables: true,
			},
		);

		assertEquals(
			content,
			`
# comment
#comment
domain.com, 1234, RESELLER, 123456789abcdef1
domain.com,1234,RESELLER,123456789abcdef1
not removed=value
domain.com, 1234, RESELLER, 123456789abcdef1
`,
		);
	},
});

Deno.test({
	name: "strip specific variables",
	fn() {
		const content = transformAdsTxt(
			`
# comment
#comment
domain.com, 1234, RESELLER, 123456789abcdef1
domain.com,1234,RESELLER,123456789abcdef1
VARIABLE1=value
notremoved = value
variable2= other value
alsonotremoved = domain.com, 1234, RESELLER, 123456789abcdef1
domain.com, 1234, RESELLER, 123456789abcdef1
`,
			{
				strip_variables: ["VARIABLE1", "variable2", "NOTREMOVED", "also not removed"],
			},
		);

		assertEquals(
			content,
			`
# comment
#comment
domain.com, 1234, RESELLER, 123456789abcdef1
domain.com,1234,RESELLER,123456789abcdef1
notremoved = value
alsonotremoved = domain.com, 1234, RESELLER, 123456789abcdef1
domain.com, 1234, RESELLER, 123456789abcdef1
`,
		);
	},
});
