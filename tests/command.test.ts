import { describe, expect, test } from "bun:test";

import { keysmithUsage, parseKeysmithCommand } from "../src/command.ts";

describe("parseKeysmithCommand", () => {
	test("defaults deploy to the builtin prompt", () => {
		expect(parseKeysmithCommand("deploy")).toEqual({
			kind: "deploy",
			yes: false,
			dryRun: false,
		});
	});

	test("parses file, name, dry-run, and yes options", () => {
		expect(
			parseKeysmithCommand('deploy --file "/tmp/custom prompt.md" --name custom --dry-run --yes'),
		).toEqual({
			kind: "deploy",
			file: "/tmp/custom prompt.md",
			name: "custom",
			yes: true,
			dryRun: true,
		});
	});

	test("accepts the prompt file positionally", () => {
		expect(parseKeysmithCommand("preview ./prompt.md --name trial")).toEqual({
			kind: "preview",
			file: "./prompt.md",
			name: "trial",
		});
	});

	test("rejects conflicting positional and --file sources", () => {
		expect(() => parseKeysmithCommand("deploy first.md --file second.md")).toThrow(
			"Specify the prompt path either positionally or with --file, not both",
		);
	});

	test("rejects duplicate and command-incompatible options", () => {
		expect(() => parseKeysmithCommand("deploy --yes --yes")).toThrow("Duplicate option: --yes");
		expect(() => parseKeysmithCommand("status --yes")).toThrow(
			"--yes is not valid for this command",
		);
	});

	test("help distinguishes persistent toggles, deployment layers, and package removal", () => {
		const usage = keysmithUsage();
		expect(usage).toContain("disable: stop injection persistently across turns and sessions");
		expect(usage).toContain("enable: resume the selected layer without creating a new deployment");
		expect(usage).toContain("uninstall: pop only the newest deployment layer");
		expect(usage).toContain("omp plugin uninstall omp-keysmith");
	});
});
