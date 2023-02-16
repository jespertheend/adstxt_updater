import { handlers, Logger } from "$std/log/mod.ts";

export const logger = new Logger("AdsTxtUpdager", "INFO", {
	handlers: [
		new handlers.ConsoleHandler("INFO", {
			formatter: "{msg}",
		}),
	],
});
