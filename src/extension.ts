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
	const selectedDeployment = state?.deployments.at(-1) ?? null;
	let injectionState: string;
	let nextAction: string;
	if (!status.healthy) {
		injectionState = "blocked by the integrity or structural issues below";
		nextAction = "Resolve the blocking issues before changing deployment state.";
	} else if (!selectedDeployment) {
		injectionState = "inactive because no deployment layer exists";
		nextAction = "Run `/keysmith preview`, then `/keysmith deploy` to create the first layer.";
	} else if (state?.enabled) {
		injectionState = "active on every agent turn";
		nextAction = "Run `/keysmith disable` to pause persistently; deploy only when adding a new layer.";
	} else {
		injectionState = "disabled persistently across turns and sessions";
		nextAction = "Run `/keysmith enable` to resume this layer without deploying again.";
	}

	const lines = [
		`Store: ${store.rootDir}`,
		`Initialized: ${status.initialized ? "yes" : "no"}`,
		`Structural health: ${status.healthy ? "healthy" : "blocked"}`,
		`Persistent switch: ${state === null ? "not initialized" : state.enabled ? "enabled" : "disabled"}`,
		`Deployment layers: ${state?.deployments.length ?? 0}`,
		`Selected deployment: ${deploymentLabel(selectedDeployment)}`,
		`Turn injection: ${injectionState}`,
		`Next action: ${nextAction}`,
		"Layer removal: `/keysmith uninstall` pops one deployment layer; it does not remove the OMP plugin.",
		"Package removal: run `omp plugin uninstall omp-keysmith` in a shell.",
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
	const selectedDeployment = status.state?.deployments.at(-1) ?? null;
	const alreadyStored =
		(status.state?.deployments.some((deployment) => deployment.hash === preview.hash) ?? false) ||
		status.unreferencedBlobs.includes(blobPath);
	const currentLayers = status.state?.deployments.length ?? 0;
	return [
		"Keysmith deployment preview",
		`Store: ${store.rootDir}`,
		`Name: ${preview.name}`,
		`Source: ${sourceLabel(preview.source)}`,
		`SHA-256: ${preview.hash}`,
		`Bytes: ${preview.bytes}`,
		`Blob: ${blobPath} (${alreadyStored ? "reuse existing content" : "publish immutable content"})`,
		`Current selected deployment: ${deploymentLabel(selectedDeployment)}`,
		`Deployment layers: ${currentLayers} -> ${currentLayers + 1}`,
		"State after deploy: the new layer is selected and injection is enabled persistently.",
		"Lifecycle note: deploy always pushes a layer. To resume a disabled existing layer, use `/keysmith enable` instead.",
		`Behavior scope: every OMP agent turn using agent directory ${path.dirname(store.rootDir)}; OMP configuration files and hooks remain untouched.`,
		preview.source.kind === "builtin" ? BUILTIN_BEHAVIOR_NOTICE : "External prompt content will be injected byte-for-byte after UTF-8 validation.",
	].join("\n");
}

function formatRecovery(result: RecoverResult): string {
	const lines = [
		`Recovery mode: ${result.apply ? "apply" : "preview"}`,
		"Scope: publication residue only; valid deployment layers and plugin installation are unchanged.",
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
		"Scope: unreferenced blobs only; selected deployment layers and plugin installation are unchanged.",
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
					`Deployed and selected ${result.deployment.name}.`,
					`SHA-256: ${result.deployment.hash}`,
					`Blob: ${result.blobCreated ? "created" : "reused"}`,
					`Deployment layers: ${result.state.deployments.length}`,
					"Persistent switch: enabled.",
					"The prompt will apply on the next agent turn and remain enabled across sessions.",
					"Use `/keysmith disable` to pause without removing this layer; use `/keysmith uninstall` to pop it.",
				].join("\n"),
				"info",
			);
			await refreshBadge(store, ctx);
			return;
		}
		case "enable": {
			const status = await store.status();
			if (!status.state || status.state.deployments.length === 0) {
				ctx.ui.notify("No deployment layer exists. Run `/keysmith preview`, then `/keysmith deploy` first.", "info");
				return;
			}
			const result = await store.setEnabled(true);
			ctx.ui.notify(
				result.changed
					? "Keysmith injection is enabled persistently across future turns and sessions. No deployment layer was created."
					: "Keysmith injection is already enabled. No deployment layer was created.",
				"info",
			);
			await refreshBadge(store, ctx);
			return;
		}
		case "disable": {
			const status = await store.status();
			if (!status.state || status.state.deployments.length === 0) {
				ctx.ui.notify("No deployment layer exists, so there is no Keysmith prompt to disable.", "info");
				return;
			}
			const result = await store.setEnabled(false);
			ctx.ui.notify(
				result.changed
					? "Keysmith injection is disabled persistently across future turns and sessions. Deployment layers are retained; use `/keysmith enable`, not deploy, to resume."
					: "Keysmith injection is already disabled. Deployment layers are retained; use `/keysmith enable` to resume.",
				"info",
			);
			await refreshBadge(store, ctx);
			return;
		}
		case "uninstall": {
			const status = await store.status();
			const current = status.state?.deployments.at(-1);
			if (!current) {
				ctx.ui.notify(
					"No managed Keysmith deployment layer is installed. `/keysmith uninstall` does not remove the OMP plugin; run `omp plugin uninstall omp-keysmith` in a shell for package removal.",
					"info",
				);
				return;
			}
			const remainingLayers = (status.state?.deployments.length ?? 1) - 1;
			const nextSelected = status.state?.deployments.at(-2) ?? null;
			const plan = [
				"Keysmith layer uninstall preview",
				`Remove newest layer: ${deploymentLabel(current)}`,
				`Remaining layers: ${remainingLayers}`,
				`Next selected deployment: ${deploymentLabel(nextSelected)}`,
				`Restore persistent switch: ${current.enabledBefore ? "enabled" : "disabled"}`,
				"Immutable prompt blobs will be retained for recovery and deduplication.",
				"This removes one deployment layer only. It does not uninstall the OMP plugin package.",
				"To remove the package, run `omp plugin uninstall omp-keysmith` in a shell.",
			].join("\n");
			if (!(await confirmMutation(ctx, command.yes, "Remove latest Keysmith deployment layer?", plan))) return;
			const result = await store.uninstall();
			const selected = result.state.deployments.at(-1) ?? null;
			ctx.ui.notify(
				[
					`Removed deployment layer ${result.removed.name}.`,
					`Remaining layers: ${result.state.deployments.length}`,
					`Selected deployment: ${deploymentLabel(selected)}`,
					`Persistent switch: ${result.state.enabled ? "enabled" : "disabled"}`,
					result.state.deployments.length === 0
						? "No deployment remains; run `/keysmith deploy` before a future enable."
						: "The OMP plugin remains installed.",
				].join("\n"),
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
		description: "Manage persistent, layered system-prompt injection; run /keysmith help for lifecycle guidance",
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
