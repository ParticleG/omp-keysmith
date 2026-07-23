import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { PromptStore } from "../src/prompt-store.ts";

const EXPECTED_BUILTIN_HASH = "2c2c9f0e008c492bfc9487170a7a08daedeb8b0625af1f85617ab2d1bd3f35c0";
const BUILTIN_PATH = resolve(import.meta.dir, "../assets/default-prompt.md");
const temporaryDirectories: string[] = [];

async function makeStore(): Promise<{ directory: string; store: PromptStore }> {
	const directory = await mkdtemp(join(tmpdir(), "omp-keysmith-test-"));
	temporaryDirectories.push(directory);
	return {
		directory,
		store: new PromptStore({ rootDir: join(directory, "store"), builtinAssetPath: BUILTIN_PATH }),
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PromptStore", () => {
	test("reads the exact builtin bytes and fixed SHA-256", async () => {
		const bytes = await readFile(BUILTIN_PATH);
		expect(bytes.byteLength).toBe(7038);
		expect(bytes.at(-1)).toBe(0x0a);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_BUILTIN_HASH);

		const { store } = await makeStore();
		const preview = await store.preview();
		expect(new TextEncoder().encode(preview.content)).toEqual(new Uint8Array(bytes));
		expect(preview.hash).toBe(EXPECTED_BUILTIN_HASH);
		expect(preview.bytes).toBe(bytes.byteLength);
	});

	test("reports an uninitialized store and has no active prompt", async () => {
		const { store } = await makeStore();
		expect(await store.status()).toEqual({
			initialized: false,
			healthy: true,
			state: null,
			activeDeployment: null,
			pendingFiles: [],
			unreferencedBlobs: [],
			issues: [],
		});
		expect(await store.getActivePrompt()).toBeNull();
	});

	test("deploys the builtin with default name and source metadata", async () => {
		const { store } = await makeStore();
		const result = await store.deploy();
		expect(result.deployment).toMatchObject({
			name: "gpt-unrestricted",
			hash: EXPECTED_BUILTIN_HASH,
			bytes: 7038,
			enabledBefore: false,
			source: {
				kind: "builtin",
				symbol: "BUILTIN_GPT_UNRESTRICTED_MD",
				version: "0.1.1-source",
				commit: "700f1be22446af4dc2c362080cbde669e215094d",
			},
		});
		expect(result.state.enabled).toBeTrue();
		expect((await store.getActivePrompt())?.content).toBe(await readFile(BUILTIN_PATH, "utf8"));
	});

	test("enables and disables injection", async () => {
		const { store } = await makeStore();
		await store.deploy();
		expect((await store.setEnabled(false)).changed).toBeTrue();
		expect(await store.getActivePrompt()).toBeNull();
		expect((await store.setEnabled(false)).changed).toBeFalse();
		expect((await store.setEnabled(true)).changed).toBeTrue();
		expect((await store.getActivePrompt())?.deployment.name).toBe("gpt-unrestricted");
	});

	test("round-trips a custom UTF-8 prompt and source path", async () => {
		const { directory, store } = await makeStore();
		const promptPath = join(directory, "custom.md");
		const content = "You are precise.\nこんにちは 🌍\n";
		await writeFile(promptPath, content, "utf8");
		const result = await store.deploy({ externalPath: promptPath, name: "international" });
		expect(result.deployment.name).toBe("international");
		expect(result.deployment.source).toEqual({ kind: "external", path: promptPath });
		expect((await store.getActivePrompt())?.content).toBe(content);
	});

	test("two-layer uninstall restores each layer's enabledBefore state", async () => {
		const { directory, store } = await makeStore();
		await store.deploy();
		await store.setEnabled(false);
		const secondPath = join(directory, "second.md");
		await writeFile(secondPath, "second layer\n", "utf8");
		const second = await store.deploy({ externalPath: secondPath, name: "second" });
		expect(second.deployment.enabledBefore).toBeFalse();
		expect((await store.uninstall()).state).toMatchObject({ enabled: false, deployments: [{ name: "gpt-unrestricted" }] });
		expect(await store.getActivePrompt()).toBeNull();
		expect((await store.uninstall()).state).toEqual({ version: 1, enabled: false, deployments: [] });
	});

	test("rejects invalid UTF-8 files and symbolic links", async () => {
		const { directory, store } = await makeStore();
		const invalidPath = join(directory, "invalid.md");
		await writeFile(invalidPath, new Uint8Array([0xc3, 0x28]));
		await expect(store.preview({ externalPath: invalidPath })).rejects.toThrow();

		const regularPath = join(directory, "regular.md");
		const linkPath = join(directory, "link.md");
		await writeFile(regularPath, "safe\n", "utf8");
		await symlink(regularPath, linkPath);
		await expect(store.preview({ externalPath: linkPath })).rejects.toThrow(/symbolic link|regular file/i);
	});

	test("detects blob hash drift and blocks subsequent deployment", async () => {
		const { directory, store } = await makeStore();
		const deployed = await store.deploy();
		const blobPath = join(directory, "store", "prompts", `${deployed.deployment.hash}.md`);
		const bytes = await readFile(blobPath);
		bytes[0] = bytes[0] === 0x41 ? 0x42 : 0x41;
		await writeFile(blobPath, bytes);

		const status = await store.status();
		expect(status.healthy).toBeFalse();
		expect(status.issues).toContainEqual(expect.objectContaining({ code: "blob-hash-mismatch", blocking: true }));
		await expect(store.deploy()).rejects.toThrow(/integrity check failed/i);
	});
});
