import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { keysmithUsage, parseKeysmithCommand, type KeysmithCommand } from "./command.ts";
import {
	BUILTIN_GPT_UNRESTRICTED_MD,
	BUILTIN_PROMPT_COMMIT,
	BUILTIN_PROMPT_SHA256,
	BUILTIN_PROMPT_VERSION,
} from "./constants.ts";
import {
	PromptStore,
	type Deployment,
	type DoctorResult,
	type PromptPreview,
	type PromptSource,
	type PromptStoreStatus,
	type RecoverResult,
} from "./prompt-store.ts";

const BUILTIN_ASSET_PATH = fileURLToPath(new URL("../assets/default-prompt.md", import.meta.url));
const STATUS_KEY = "keysmith";
const BUILTIN_BEHAVIOR_NOTICE =
	"The bundled prompt suppresses refusal/warning framing and reinterprets authorization boundaries across security, adult, chemistry, pharmacology, and weapons requests. It is appended as a system-prompt block on every agent turn while enabled.";

function sourceLabel(source: PromptSource): string {
	if (source.kind === "external") return `external file ${source.path}`;
	return `${source.symbol} from codex-keysmith ${source.version} at ${source.commit}`;
}

function deploymentLabel(deployment: Deployment | null): string {
	if (!deployment) return "none";
	return `${deployment.name} (${deployment.hash}, ${deployment.bytes} bytes, ${sourceLabel(deployment.source)})`;
}

function formatStatus(store: PromptStore, status: PromptStoreStatus): string {
	const state = status.state;
	const lines = [
		`Store: ${store.rootDir}`,
		`Initialized: ${status.initialized ? "yes" : "no"}`,
		`Structural health: ${status.healthy ? "healthy" : "blocked"}`,
		`Enabled: ${state?.enabled ? "yes" : "no"}`,
		`Layers: ${state?.deployments.length ?? 0}`,
		`Active: ${deploymentLabel(status.activeDeployment)}`,
		`Injection readiness: ${status.activeDeployment && status.healthy ? "ready" : state?.enabled ? "blocked" : "inactive"}`,
	];
	if (status.pendingFiles.length > 0) lines.push(`Pending publications: ${status.pendingFiles.join(", ")}`);
	if (status.unreferencedBlobs.length > 0) lines.push(`Unreferenced blobs: ${status.unreferencedBlobs.join(", ")}`);
	if (status.issues.length > 0) {
		lines.push("Issues:");
		for (const issue of status.issues) {
			lines.push(`- ${issue.blocking ? "BLOCKING" : "NOTICE"} [${issue.code}] ${issue.message}`);
		}
	}
	return lines.join("\n");
}

function formatPreview(store: PromptStore, preview: PromptPreview, status: PromptStoreStatus): string {
	const blobPath = path.join(store.promptsDir, `${preview.hash}.md`);
	const alreadyStored = status.state?.deployments.some((deployment) => deployment.hash === preview.hash) ?? false;
	return [
		"Keysmith deployment preview",
		`Store: ${store.rootDir}`,
		`Name: ${preview.name}`,
		`Source: ${sourceLabel(preview.source)}`,
		`SHA-256: ${preview.hash}`,
		`Bytes: ${preview.bytes}`,
		`Blob: ${blobPath} (${alreadyStored ? "reuse existing content" : "publish immutable content"})`,
		`Current active: ${deploymentLabel(status.activeDeployment)}`,
		"Plan: push one owned deployment layer, select it as active, and enable turn-level injection.",
		`Behavior scope: every OMP agent turn using agent directory ${path.dirname(store.rootDir)}; OMP configuration files and hooks remain untouched.`,
		preview.source.kind === "builtin" ? BUILTIN_BEHAVIOR_NOTICE : "External prompt content will be injected byte-for-byte after UTF-8 validation.",
	].join("\n");
}

function formatRecovery(result: RecoverResult): string {
	const lines = [
		`Recovery mode: ${result.apply ? "apply" : "preview"}`,
		`Lock: ${result.lockDisposition}${result.lockPath ? ` (${result.lockPath})` : ""}`,
		`Pending publications: ${result.pendingFiles.length > 0 ? result.pendingFiles.join(", ") : "none"}`,
	];
	if (result.removed.length > 0) lines.push(`Removed: ${result.removed.join(", ")}`);
	if (result.blockers.length > 0) lines.push(`Blockers: ${result.blockers.join("; ")}`);
	return lines.join("\n");
}

function formatDoctor(result: DoctorResult): string {
	const lines = [
		`Doctor mode: ${result.fix ? "fix" : "preview"}`,
		`Unreferenced blobs: ${result.unreferencedBlobs.length > 0 ? result.unreferencedBlobs.join(", ") : "none"}`,
	];
	if (result.removed.length > 0) lines.push(`Removed: ${result.removed.join(", ")}`);
	if (result.blockers.length > 0) lines.push(`Blockers: ${result.blockers.join("; ")}`);
	return lines.join("\n");
}

async function confirmMutation(
	ctx: ExtensionCommandContext,
	explicitYes: boolean,
	title: string,
	message: string,
): Promise<boolean> {
	if (explicitYes) return true;
	ctx.ui.notify(message, "info");
	if (!ctx.hasUI) {
		ctx.ui.notify("No interactive UI is available; run the command again with --yes to apply it.", "warning");
		return false;
	}
	return ctx.ui.confirm(title, message);
}

async function refreshBadge(store: PromptStore, ctx: ExtensionContext): Promise<void> {
	const active = await store.getActivePrompt();
	ctx.ui.setStatus(STATUS_KEY, active ? `keysmith:${active.deployment.name}` : undefined);
}

async function handleCommand(
	store: PromptStore,
	command: KeysmithCommand,
	ctx: ExtensionCommandContext,
): Promise<void> {
	switch (command.kind) {
		case "help":
			ctx.ui.notify(keysmithUsage(), "info");
			return;
		case "status": {
			const status = await store.status();
			ctx.ui.notify(formatStatus(store, status), status.healthy ? "info" : "error");
			return;
		}
		case "preview": {
			const preview = await store.preview({
				name: command.name,
				externalPath: command.file ? path.resolve(ctx.cwd, command.file) : undefined,
			});
			const status = await store.status();
			ctx.ui.notify(formatPreview(store, preview, status), status.healthy ? "info" : "error");
			return;
		}
		case "deploy": {
			const options = {
				name: command.name,
				externalPath: command.file ? path.resolve(ctx.cwd, command.file) : undefined,
			};
			const preview = await store.preview(options);
			const status = await store.status();
			const plan = formatPreview(store, preview, status);
			if (command.dryRun) {
				ctx.ui.notify(plan, status.healthy ? "info" : "error");
				return;
			}
			if (!status.healthy) {
				ctx.ui.notify(plan, "error");
				return;
			}
			if (!(await confirmMutation(ctx, command.yes, "Deploy Keysmith prompt?", plan))) return;
			const result = await store.deploy(options);
			ctx.ui.notify(
				[
					`Deployed ${result.deployment.name}.`,
					`SHA-256: ${result.deployment.hash}`,
					`Blob: ${result.blobCreated ? "created" : "reused"}`,
					`Layers: ${result.state.deployments.length}`,
					"The prompt will apply on the next agent turn.",
				].join("\n"),
				"info",
			);
			await refreshBadge(store, ctx);
			return;
		}
		case "enable": {
			const result = await store.setEnabled(true);
			ctx.ui.notify(result.changed ? "Keysmith injection enabled for the next agent turn." : "Keysmith injection is already enabled.", "info");
			await refreshBadge(store, ctx);
			return;
		}
		case "disable": {
			const result = await store.setEnabled(false);
			ctx.ui.notify(result.changed ? "Keysmith injection disabled for the next agent turn." : "Keysmith injection is already disabled.", "info");
			await refreshBadge(store, ctx);
			return;
		}
		case "uninstall": {
			const status = await store.status();
			const current = status.state?.deployments.at(-1);
			if (!current) {
				ctx.ui.notify("No managed Keysmith deployment layer is installed.", "info");
				return;
			}
			const plan = [
				"Keysmith uninstall preview",
				`Remove layer: ${deploymentLabel(current)}`,
				`Restore enabled state: ${current.enabledBefore ? "enabled" : "disabled"}`,
				"Immutable prompt blobs will be retained for recovery and deduplication.",
			].join("\n");
			if (!(await confirmMutation(ctx, command.yes, "Uninstall latest Keysmith layer?", plan))) return;
			const result = await store.uninstall();
			ctx.ui.notify(
				`Removed layer ${result.removed.name}. Remaining layers: ${result.state.deployments.length}. Injection is ${result.state.enabled ? "enabled" : "disabled"}.`,
				"info",
			);
			await refreshBadge(store, ctx);
			return;
		}
		case "recover": {
			const preview = await store.recover(false);
			const plan = formatRecovery(preview);
			if (preview.blockers.length > 0 || (preview.pendingFiles.length === 0 && preview.lockDisposition === "absent")) {
				ctx.ui.notify(plan, preview.blockers.length > 0 ? "error" : "info");
				return;
			}
			if (!(await confirmMutation(ctx, command.yes, "Recover Keysmith publication residue?", plan))) return;
			ctx.ui.notify(formatRecovery(await store.recover(true)), "info");
			return;
		}
		case "doctor": {
			const preview = await store.doctor(false);
			const plan = formatDoctor(preview);
			if (!command.fix || preview.blockers.length > 0 || preview.unreferencedBlobs.length === 0) {
				ctx.ui.notify(plan, preview.blockers.length > 0 ? "error" : "info");
				return;
			}
			if (!(await confirmMutation(ctx, command.yes, "Remove unreferenced Keysmith blobs?", plan))) return;
			ctx.ui.notify(formatDoctor(await store.doctor(true)), "info");
			return;
		}
	}
}

export default function keysmithExtension(pi: ExtensionAPI): void {
	const store = new PromptStore({
		rootDir: path.join(pi.pi.getAgentDir(), "keysmith"),
		builtinAssetPath: BUILTIN_ASSET_PATH,
	});
	let lastInjectionError: string | undefined;

	pi.setLabel("Keysmith");

	pi.registerCommand("keysmith", {
		description: "Preview, deploy, enable, disable, roll back, and verify managed system prompts",
		handler: async (raw, ctx) => {
			try {
				await handleCommand(store, parseKeysmithCommand(raw), ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pi.logger.error("Keysmith command failed", { error: message });
				ctx.ui.notify(`Keysmith error: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await refreshBadge(store, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pi.logger.error("Keysmith status initialization failed", { error: message });
			ctx.ui.setStatus(STATUS_KEY, "keysmith:blocked");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const active = await store.getActivePrompt();
			lastInjectionError = undefined;
			ctx.ui.setStatus(STATUS_KEY, active ? `keysmith:${active.deployment.name}` : undefined);
			if (!active) return;
			return { systemPrompt: [...event.systemPrompt, active.content] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pi.logger.error("Keysmith prompt injection failed", { error: message });
			ctx.ui.setStatus(STATUS_KEY, "keysmith:blocked");
			if (lastInjectionError !== message) {
				ctx.ui.notify(`Keysmith injection blocked: ${message}`, "error");
				lastInjectionError = message;
			}
			return;
		}
	});
}

export const builtinPromptMetadata = {
	symbol: BUILTIN_GPT_UNRESTRICTED_MD,
	version: BUILTIN_PROMPT_VERSION,
	commit: BUILTIN_PROMPT_COMMIT,
	sha256: BUILTIN_PROMPT_SHA256,
} as const;
