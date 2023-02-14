import { generateTypes } from "https://deno.land/x/deno_tsc_helper@v0.3.0/mod.js";
import { setCwd } from "https://deno.land/x/chdir_anywhere@v0.0.2/mod.js";
import { run } from "../src/main.js";
setCwd(import.meta.url);
Deno.chdir("..");

generateTypes({
	outputDir: ".denoTypes",
	importMap: "importmap.json",
	include: [
		"scripts",
		"src",
	],
	logLevel: "WARNING",
});

run([
	"dev/config1.yml",
	"dev/config2.yml",
]);
