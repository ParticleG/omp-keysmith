import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import keysmithExtension from "../src/extension.ts";

const BUILTIN_PATH = resolve(import.meta.dir, "../assets/default-prompt.md");
const temporaryDirectories: string[] = [];

interface TestContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		setStatus(key: string, value: string | undefined): void;
		notify(message: string, level: string): void;
		confirm(): Promise<boolean>;
	};
}

interface TestEvent {
	systemPrompt?: string[];
}

type Handler = (
	first: string | TestEvent,
	ctx: TestContext,
) => Promise<{ systemPrompt: string[] } | undefined>;

async function makeHarness() {
	const agentDir = await mkdtemp(join(tmpdir(), "omp-keysmith-extension-test-"));
	const workspaceDir = join(agentDir, "workspace");
	await mkdir(workspaceDir);
	temporaryDirectories.push(agentDir);
	const commands = new Map<string, { description: string; handler: Handler }>();
	const events = new Map<string, Handler>();
	const labels: string[] = [];
	const errors: unknown[][] = [];
	const statusCalls: Array<[string, string | undefined]> = [];
	const notifications: Array<[string, string]> = [];
	const ui = {
		setStatus(key: string, value: string | undefined) {
			statusCalls.push([key, value]);
		},
		notify(message: string, level: string) {
			notifications.push([message, level]);
		},
		confirm: async () => true,
	};
	const api = {
		pi: { getAgentDir: () => agentDir },
		setLabel(label: string) {
			labels.push(label);
		},
		registerCommand(name: string, command: { description: string; handler: Handler }) {
			commands.set(name, command);
		},
		on(name: string, handler: Handler) {
			events.set(name, handler);
		},
		logger: {
			error(...args: unknown[]) {
				errors.push(args);
			},
		},
	};
	// This intentionally minimal in-process harness implements only the API surface used by the extension.
	keysmithExtension(api as unknown as ExtensionAPI);
	const ctx = { cwd: workspaceDir, hasUI: false, ui };
	return { agentDir, workspaceDir, commands, events, labels, errors, statusCalls, notifications, ctx };
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("keysmith extension", () => {
	test("registers its command and lifecycle hooks", async () => {
		const harness = await makeHarness();
		expect(harness.labels).toEqual(["Keysmith"]);
		expect(harness.commands.get("keysmith")?.description).toContain("managed system prompts");
		expect(harness.commands.get("keysmith")?.handler).toBeFunction();
		expect(harness.events.get("session_start")).toBeFunction();
		expect(harness.events.get("before_agent_start")).toBeFunction();
	});

	test("treats a missing state on session_start as inactive, not blocked", async () => {
		const harness = await makeHarness();
		await harness.events.get("session_start")?.({}, harness.ctx);
		expect(harness.statusCalls).toEqual([["keysmith", undefined]]);
		expect(harness.statusCalls).not.toContainEqual(["keysmith", "keysmith:blocked"]);
		expect(harness.errors).toEqual([]);
	});

	test("deploys the builtin, appends it after existing blocks, and stops after disable", async () => {
		const harness = await makeHarness();
		const command = harness.commands.get("keysmith");
		expect(command).toBeDefined();
		await command!.handler("deploy --yes", harness.ctx);
		expect(harness.errors).toEqual([]);

		const existing = ["existing system block one", "existing system block two"];
		const injected = await harness.events.get("before_agent_start")?.(
			{ systemPrompt: existing },
			harness.ctx,
		);
		if (!injected) throw new Error("before_agent_start did not return a system prompt");
		const builtin = await readFile(BUILTIN_PATH, "utf8");
		expect(injected).toEqual({ systemPrompt: [...existing, builtin] });
		expect(injected.systemPrompt.at(-1)).toBe(builtin);

		await command!.handler("disable", harness.ctx);
		const disabled = await harness.events.get("before_agent_start")?.(
			{ systemPrompt: existing },
			harness.ctx,
		);
		expect(disabled).toBeUndefined();
		expect(harness.statusCalls.at(-1)).toEqual(["keysmith", undefined]);
	});

	test("resolves relative prompt files from the live OMP cwd", async () => {
		const harness = await makeHarness();
		const promptPath = join(harness.workspaceDir, "relative.md");
		await writeFile(promptPath, "workspace-relative prompt\n", "utf8");

		const command = harness.commands.get("keysmith");
		if (!command) throw new Error("keysmith command was not registered");
		await command.handler("deploy --file relative.md --name relative --yes", harness.ctx);

		const injected = await harness.events.get("before_agent_start")?.(
			{ systemPrompt: ["base"] },
			harness.ctx,
		);
		expect(injected).toEqual({ systemPrompt: ["base", "workspace-relative prompt\n"] });

		const state = JSON.parse(await readFile(join(harness.agentDir, "keysmith", "state.json"), "utf8"));
		expect(state.deployments[0].source).toEqual({ kind: "external", path: promptPath });
	});
});
