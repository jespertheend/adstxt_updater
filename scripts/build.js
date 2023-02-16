import * as path from "$std/path/mod.ts";
import * as fs from "$std/fs/mod.ts";
import { setCwd } from "https://deno.land/x/chdir_anywhere@v0.0.2/mod.js";
import {Tar} from "$std/archive/tar.ts";
import * as streams from "$std/streams/mod.ts";
setCwd(import.meta.url);
Deno.chdir("..");

let targets = [Deno.build.target];
if (Deno.args.includes("--all")) {
	targets = [
		"x86_64-unknown-linux-gnu",
		"x86_64-pc-windows-msvc",
		"x86_64-apple-darwin",
		"aarch64-apple-darwin",
	];
}

const outDir = path.resolve("dist");
await fs.ensureDir(outDir);

for (const target of targets) {
	const output = path.resolve(outDir, `${target}/adstxt_updater`);
	const cmd = `deno compile --allow-net --allow-read --allow-write --target ${target} --output ${output} src/main.js`;
	const process = Deno.run({
		cmd: cmd.split(" "),
	});
	const status = await process.status();
	if (!status.success) {
		throw new Error("deno compile exited with an unsuccessful status code: " + status.code);
	}
}

if (Deno.args.includes("--compress")) {
	const collectedTars = [];
	for (const target of targets) {
		const tar = new Tar();
		const dir = path.resolve(outDir, target);
		for await (const entry of Deno.readDir(dir)) {
			if (entry.isFile) {
				console.log(entry.name);
				await tar.append(entry.name, {
					filePath: path.resolve(dir, entry.name),
				});
			}
		}
		collectedTars.push({target, tar});
	}

	for (const {target, tar} of collectedTars) {
		const tarDestination = path.resolve(outDir, "adstxt_updater_" + target + ".tar");
		const writer = await Deno.open(tarDestination, {write: true, create: true});
		await streams.copy(tar.getReader(), writer);
		writer.close();
		await Deno.remove(path.resolve(outDir, target), {recursive: true});
	}
}
