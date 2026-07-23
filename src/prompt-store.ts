import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
	BLOB_FILE_PATTERN,
	BLOB_TEMP_FILE_PATTERN,
	BUILTIN_GPT_UNRESTRICTED_MD,
	BUILTIN_PROMPT_COMMIT,
	BUILTIN_PROMPT_SHA256,
	BUILTIN_PROMPT_VERSION,
	DEFAULT_PROMPT_NAME,
	LOCK_OWNER,
	PROMPTS_DIRECTORY_NAME,
	SAFE_PROMPT_NAME_PATTERN,
	SHA256_PATTERN,
	STATE_FILE_NAME,
	STATE_SCHEMA_VERSION,
	STATE_TEMP_FILE_PATTERN,
	WRITE_LOCK_FILE_NAME,
} from "./constants.ts";
import {
	ensurePrivateDirectory,
	fsyncDirectory,
	listDirectory,
	publishTempFile,
	publishImmutableTempFile,
	randomToken,
	readRegularFile,
	readRegularUtf8,
	removeExactRegularFile,
	sha256Hex,
	writeExclusiveFile,
} from "./safe-fs.ts";
import type { FileIdentity } from "./safe-fs.ts";
import type {
	ActivePrompt,
	BuiltinPromptSource,
	DeployResult,
	Deployment,
	DoctorResult,
	ExternalPromptSource,
	PromptInputOptions,
	PromptPreview,
	PromptSource,
	PromptStoreOptions,
	PromptStoreStateV1,
	PromptStoreStatus,
	RecoverResult,
	RecoveryLockDisposition,
	SetEnabledResult,
	StatusIssue,
	UninstallResult,
} from "./types.ts";

interface LockRecord {
	owner: typeof LOCK_OWNER;
	version: 1;
	pid: number;
	hostname: string;
	createdAt: string;
	token: string;
}

interface LockInspection {
	disposition: RecoveryLockDisposition;
	identity?: FileIdentity;
	record?: LockRecord;
	message?: string;
}

interface StoreInspection {
	status: PromptStoreStatus;
	validBlobs: Map<string, string>;
	abnormalPromptNodes: string[];
}

interface StateSnapshot {
	state: PromptStoreStateV1;
	identity: FileIdentity;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as Error & { code?: unknown }).code === code
	);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSafePromptName(name: string): boolean {
	return (
		name.length > 0 &&
		name !== "." &&
		name !== ".." &&
		!name.includes("..") &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes(" ") &&
		!name.endsWith(".") &&
		SAFE_PROMPT_NAME_PATTERN.test(name) &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	);
}

function parseSource(value: unknown, location: string): PromptSource {
	if (!isObject(value) || typeof value.kind !== "string") {
		throw new Error(`Invalid prompt source at ${location}`);
	}
	if (value.kind === "builtin") {
		if (
			!hasExactKeys(value, ["kind", "symbol", "version", "commit"]) ||
			value.symbol !== BUILTIN_GPT_UNRESTRICTED_MD ||
			value.version !== BUILTIN_PROMPT_VERSION ||
			value.commit !== BUILTIN_PROMPT_COMMIT
		) {
			throw new Error(`Invalid built-in prompt source at ${location}`);
		}
		return {
			kind: "builtin",
			symbol: BUILTIN_GPT_UNRESTRICTED_MD,
			version: BUILTIN_PROMPT_VERSION,
			commit: BUILTIN_PROMPT_COMMIT,
		};
	}
	if (value.kind === "external") {
		if (
			!hasExactKeys(value, ["kind", "path"]) ||
			typeof value.path !== "string" ||
			value.path.length === 0 ||
			!path.isAbsolute(value.path)
		) {
			throw new Error(`Invalid external prompt source at ${location}`);
		}
		return { kind: "external", path: value.path };
	}
	throw new Error(`Unknown prompt source kind at ${location}`);
}

function parseDeployment(value: unknown, index: number): Deployment {
	const location = `deployments[${index}]`;
	if (
		!isObject(value) ||
		!hasExactKeys(value, [
			"id",
			"name",
			"hash",
			"bytes",
			"source",
			"deployedAt",
			"enabledBefore",
		]) ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.name !== "string" ||
		!isSafePromptName(value.name) ||
		typeof value.hash !== "string" ||
		!SHA256_PATTERN.test(value.hash) ||
		typeof value.bytes !== "number" ||
		!Number.isSafeInteger(value.bytes) ||
		value.bytes < 0 ||
		!isIsoTimestamp(value.deployedAt) ||
		typeof value.enabledBefore !== "boolean"
	) {
		throw new Error(`Invalid deployment at ${location}`);
	}
	return {
		id: value.id,
		name: value.name,
		hash: value.hash,
		bytes: value.bytes,
		source: parseSource(value.source, `${location}.source`),
		deployedAt: value.deployedAt,
		enabledBefore: value.enabledBefore,
	};
}

function parseState(content: string, statePath: string): PromptStoreStateV1 {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new Error(`Invalid JSON in state file: ${statePath}`, { cause: error });
	}
	if (
		!isObject(value) ||
		!hasExactKeys(value, ["version", "enabled", "deployments"]) ||
		value.version !== STATE_SCHEMA_VERSION ||
		typeof value.enabled !== "boolean" ||
		!Array.isArray(value.deployments)
	) {
		throw new Error(`Invalid state schema: ${statePath}`);
	}
	const deployments = value.deployments.map(parseDeployment);
	const ids = new Set(deployments.map((deployment) => deployment.id));
	if (ids.size !== deployments.length) {
		throw new Error(`State contains duplicate deployment IDs: ${statePath}`);
	}
	if (value.enabled && deployments.length === 0) {
		throw new Error(`State cannot be enabled without a deployment: ${statePath}`);
	}
	return { version: STATE_SCHEMA_VERSION, enabled: value.enabled, deployments };
}

function parseLock(content: string): LockRecord {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new Error("Lock file is not valid JSON", { cause: error });
	}
	if (
		!isObject(value) ||
		!hasExactKeys(value, ["owner", "version", "pid", "hostname", "createdAt", "token"]) ||
		value.owner !== LOCK_OWNER ||
		value.version !== 1 ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.hostname !== "string" ||
		value.hostname.length === 0 ||
		!isIsoTimestamp(value.createdAt) ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{32}$/.test(value.token)
	) {
		throw new Error("Lock file has an invalid schema");
	}
	return {
		owner: LOCK_OWNER,
		version: 1,
		pid: value.pid,
		hostname: value.hostname,
		createdAt: value.createdAt,
		token: value.token,
	};
}

export class PromptStore {
	readonly rootDir: string;
	readonly builtinAssetPath: string;
	readonly promptsDir: string;
	readonly statePath: string;
	readonly lockPath: string;

	constructor(options: PromptStoreOptions) {
		if (!path.isAbsolute(options.rootDir) || !path.isAbsolute(options.builtinAssetPath)) {
			throw new Error("Prompt store and built-in asset paths must be absolute");
		}
		this.rootDir = path.resolve(options.rootDir);
		this.builtinAssetPath = path.resolve(options.builtinAssetPath);
		this.promptsDir = path.join(this.rootDir, PROMPTS_DIRECTORY_NAME);
		this.statePath = path.join(this.rootDir, STATE_FILE_NAME);
		this.lockPath = path.join(this.rootDir, WRITE_LOCK_FILE_NAME);
	}

	async preview(options: PromptInputOptions = {}): Promise<PromptPreview> {
		const name = options.name ?? DEFAULT_PROMPT_NAME;
		if (!isSafePromptName(name)) {
			throw new Error(`Invalid prompt name: ${name}`);
		}

		if (options.externalPath !== undefined) {
			const externalPath = path.resolve(options.externalPath);
			const file = await readRegularUtf8(externalPath);
			const source: ExternalPromptSource = { kind: "external", path: externalPath };
			return {
				name,
				hash: sha256Hex(file.bytes),
				bytes: file.bytes.byteLength,
				content: file.content,
				source,
			};
		}

		const file = await readRegularUtf8(this.builtinAssetPath);
		const hash = sha256Hex(file.bytes);
		if (hash !== BUILTIN_PROMPT_SHA256) {
			throw new Error(
				`Built-in prompt hash mismatch: expected ${BUILTIN_PROMPT_SHA256}, received ${hash}`,
			);
		}
		const source: BuiltinPromptSource = {
			kind: "builtin",
			symbol: BUILTIN_GPT_UNRESTRICTED_MD,
			version: BUILTIN_PROMPT_VERSION,
			commit: BUILTIN_PROMPT_COMMIT,
		};
		return {
			name,
			hash,
			bytes: file.bytes.byteLength,
			content: file.content,
			source,
		};
	}

	async status(): Promise<PromptStoreStatus> {
		return (await this.inspectStore()).status;
	}

	async deploy(options: PromptInputOptions = {}): Promise<DeployResult> {
		const preview = await this.preview(options);
		return this.withWriteLock(async () => {
			const state = await this.preflightStore(false);
			const blobPath = this.blobPath(preview.hash);
			let blobCreated = false;
			try {
				await this.verifyBlob(blobPath, preview.hash, preview.bytes);
			} catch (error) {
				if (!isNodeError(error instanceof Error && "cause" in error ? error.cause : error, "ENOENT")) {
					throw error;
				}
				const tempPath = path.join(
					this.promptsDir,
					`.${preview.hash}.${process.pid}.${randomToken()}.tmp`,
				);
				await publishImmutableTempFile(tempPath, blobPath, new TextEncoder().encode(preview.content));
				blobCreated = true;
			}
			const deployment: Deployment = {
				id: randomUUID(),
				name: preview.name,
				hash: preview.hash,
				bytes: preview.bytes,
				source: preview.source,
				deployedAt: new Date().toISOString(),
				enabledBefore: state.enabled,
			};
			const nextState: PromptStoreStateV1 = {
				version: STATE_SCHEMA_VERSION,
				enabled: true,
				deployments: [...state.deployments, deployment],
			};
			await this.writeState(nextState);
			return { deployment, state: nextState, blobCreated };
		});
	}

	async setEnabled(enabled: boolean): Promise<SetEnabledResult> {
		return this.withWriteLock(async () => {
			const state = await this.preflightStore(true);
			if (enabled && state.deployments.length === 0) {
				throw new Error("Cannot enable the prompt store without a deployment");
			}
			if (enabled) {
				const active = state.deployments.at(-1);
				if (active === undefined) {
					throw new Error("Cannot enable the prompt store without a deployment");
				}
				await this.verifyBlob(this.blobPath(active.hash), active.hash, active.bytes);
			}
			if (state.enabled === enabled) return { changed: false, state };
			const nextState = { ...state, enabled };
			await this.writeState(nextState);
			return { changed: true, state: nextState };
		});
	}

	async uninstall(): Promise<UninstallResult> {
		return this.withWriteLock(async () => {
			const state = await this.preflightStore(true);
			const removed = state.deployments.at(-1);
			if (removed === undefined) throw new Error("No deployment is installed");
			const nextState: PromptStoreStateV1 = {
				version: STATE_SCHEMA_VERSION,
				enabled: removed.enabledBefore,
				deployments: state.deployments.slice(0, -1),
			};
			if (nextState.enabled && nextState.deployments.length === 0) {
				throw new Error("Deployment history cannot restore enabled state without a prior layer");
			}
			if (nextState.enabled) {
				const nextActive = nextState.deployments.at(-1);
				if (nextActive === undefined) {
					throw new Error("Deployment history cannot restore enabled state without a prior layer");
				}
				await this.verifyBlob(
					this.blobPath(nextActive.hash),
					nextActive.hash,
					nextActive.bytes,
				);
			}
			await this.writeState(nextState);
			return { removed, state: nextState };
		});
	}

	async recover(apply = false): Promise<RecoverResult> {
		const rootExists = await this.rootExists();
		if (!rootExists) {
			return {
				apply,
				lockDisposition: "absent",
				lockPath: null,
				pendingFiles: [],
				removed: [],
				blockers: [],
			};
		}
		const lock = await this.inspectLock();
		const pending = await this.findPendingFiles();
		const blockers: string[] = [];
		if (["live-same-host", "foreign-host", "abnormal"].includes(lock.disposition)) {
			blockers.push(lock.message ?? `Lock is ${lock.disposition}: ${this.lockPath}`);
		}
		blockers.push(...pending.blockers);
		const result: RecoverResult = {
			apply,
			lockDisposition: lock.disposition,
			lockPath: lock.disposition === "absent" ? null : this.lockPath,
			pendingFiles: pending.files,
			removed: [],
			blockers,
		};
		if (!apply || blockers.length > 0) return result;

		const removePending = async () => {
			for (const pendingPath of pending.files) {
				await removeExactRegularFile(pendingPath);
				result.removed.push(pendingPath);
			}
		};
		if (lock.disposition === "stale-same-host") {
			await removePending();
			await removeExactRegularFile(this.lockPath, lock.identity);
			result.removed.push(this.lockPath);
			return result;
		}
		await this.withWriteLock(removePending, true);
		return result;
	}

	async doctor(fix = false): Promise<DoctorResult> {
		const examine = async (): Promise<DoctorResult> => {
			const inspection = await this.inspectStore(!fix);
			const blockers = inspection.status.issues
				.filter((issue) => issue.blocking)
				.map((issue) => issue.message);
			const result: DoctorResult = {
				fix,
				unreferencedBlobs: inspection.status.unreferencedBlobs,
				removed: [],
				blockers,
			};
			if (!fix || blockers.length > 0) return result;
			for (const blobPath of inspection.status.unreferencedBlobs) {
				await removeExactRegularFile(blobPath);
				result.removed.push(blobPath);
			}
			return result;
		};
		if (!fix) return examine();
		return this.withWriteLock(examine, true);
	}

	async getActivePrompt(): Promise<ActivePrompt | null> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			let snapshot: StateSnapshot;
			try {
				snapshot = await this.readStateSnapshot();
			} catch (error) {
				if (isNodeError(error instanceof Error && "cause" in error ? error.cause : error, "ENOENT")) {
					return null;
				}
				throw error;
			}
			const state = snapshot.state;
			const deployment = state.enabled ? state.deployments.at(-1) : undefined;
			if (state.enabled && deployment === undefined) {
				throw new Error("Enabled prompt store has no active deployment");
			}
			const file =
				deployment === undefined
					? null
					: await this.verifyBlob(
							this.blobPath(deployment.hash),
							deployment.hash,
							deployment.bytes,
						);
			const confirmedSnapshot = await this.readStateSnapshot();
			const confirmedState = confirmedSnapshot.state;
			if (
				snapshot.identity.dev !== confirmedSnapshot.identity.dev ||
				snapshot.identity.ino !== confirmedSnapshot.identity.ino ||
				JSON.stringify(state) !== JSON.stringify(confirmedState)
			) {
				continue;
			}
			if (deployment === undefined || file === null) return null;
			return { content: file.content, deployment };
		}
		throw new Error("Active prompt state changed repeatedly while reading");
	}

	private blobPath(hash: string): string {
		if (!SHA256_PATTERN.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
		return path.join(this.promptsDir, `${hash}.md`);
	}

	private async rootExists(): Promise<boolean> {
		try {
			const stats = await lstat(this.rootDir);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new Error(`Expected a real prompt store directory: ${this.rootDir}`);
			}
			return true;
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return false;
			throw error;
		}
	}

	private async initializeDirectories(): Promise<void> {
		await ensurePrivateDirectory(this.rootDir);
		await ensurePrivateDirectory(this.promptsDir);
	}

	private async readStateSnapshot(): Promise<StateSnapshot> {
		const file = await readRegularUtf8(this.statePath);
		return {
			state: parseState(file.content, this.statePath),
			identity: file.identity,
		};
	}

	private async readStateRequired(): Promise<PromptStoreStateV1> {
		return (await this.readStateSnapshot()).state;
	}

	private async preflightStore(stateRequired: boolean): Promise<PromptStoreStateV1> {
		const inspection = await this.inspectStore(false);
		const blockers = inspection.status.issues.filter((issue) => issue.blocking);
		if (blockers.length > 0) {
			throw new Error(
				`Prompt store integrity check failed: ${blockers.map((issue) => issue.message).join("; ")}`,
			);
		}
		if (inspection.status.state !== null) return inspection.status.state;
		if (stateRequired) throw new Error(`Prompt store state does not exist: ${this.statePath}`);
		return { version: STATE_SCHEMA_VERSION, enabled: false, deployments: [] };
	}
	private async writeState(state: PromptStoreStateV1): Promise<void> {
		const tempPath = path.join(
			this.rootDir,
			`.state.${process.pid}.${randomToken()}.tmp`,
		);
		await publishTempFile(tempPath, this.statePath, `${JSON.stringify(state, null, 2)}\n`);
	}

	private async verifyBlob(blobPath: string, hash: string, bytes: number) {
		const file = await readRegularUtf8(blobPath);
		if (file.bytes.byteLength !== bytes) {
			throw new Error(`Blob size mismatch: ${blobPath}`);
		}
		const actualHash = sha256Hex(file.bytes);
		if (actualHash !== hash) {
			throw new Error(`Blob hash mismatch: ${blobPath}`);
		}
		return file;
	}

	private async withWriteLock<T>(
		operation: () => Promise<T>,
		allowRecoveryResidue = false,
	): Promise<T> {
		await this.initializeDirectories();
		const record: LockRecord = {
			owner: LOCK_OWNER,
			version: 1,
			pid: process.pid,
			hostname: hostname(),
			createdAt: new Date().toISOString(),
			token: randomToken(),
		};
		let identity: FileIdentity;
		try {
			identity = await writeExclusiveFile(this.lockPath, `${JSON.stringify(record)}\n`);
			await fsyncDirectory(this.rootDir);
		} catch (error) {
			if (isNodeError(error, "EEXIST")) {
				throw new Error(`Write lock already exists; inspect it with recover(): ${this.lockPath}`, {
					cause: error,
				});
			}
			throw error;
		}
		try {
			if (!allowRecoveryResidue) {
				const pending = await this.findPendingFiles();
				if (pending.files.length > 0 || pending.blockers.length > 0) {
					const residue = [...pending.files, ...pending.blockers].join(", ");
					throw new Error(`Pending publication residue blocks writes; inspect it with recover(): ${residue}`);
				}
			}
			return await operation();
		} finally {
			await removeExactRegularFile(this.lockPath, identity);
		}
	}

	private async inspectLock(): Promise<LockInspection> {
		let file;
		try {
			file = await readRegularUtf8(this.lockPath);
		} catch (error) {
			if (isNodeError(error instanceof Error && "cause" in error ? error.cause : error, "ENOENT")) {
				return { disposition: "absent" };
			}
			return { disposition: "abnormal", message: `Abnormal lock node: ${this.lockPath}` };
		}
		let record: LockRecord;
		try {
			record = parseLock(file.content);
		} catch (error) {
			return {
				disposition: "abnormal",
				identity: file.identity,
				message: error instanceof Error ? error.message : `Invalid lock: ${this.lockPath}`,
			};
		}
		if (record.hostname !== hostname()) {
			return {
				disposition: "foreign-host",
				identity: file.identity,
				record,
				message: `Lock belongs to host ${record.hostname}: ${this.lockPath}`,
			};
		}
		try {
			process.kill(record.pid, 0);
			return {
				disposition: "live-same-host",
				identity: file.identity,
				record,
				message: `Lock owner process ${record.pid} is still alive: ${this.lockPath}`,
			};
		} catch (error) {
			if (!isNodeError(error, "ESRCH")) {
				return {
					disposition: "live-same-host",
					identity: file.identity,
					record,
					message: `Cannot prove lock owner process ${record.pid} is dead: ${this.lockPath}`,
				};
			}
		}
		return { disposition: "stale-same-host", identity: file.identity, record };
	}

	private async findPendingFiles(): Promise<{ files: string[]; blockers: string[] }> {
		const files: string[] = [];
		const blockers: string[] = [];
		const scan = async (directory: string, pattern: RegExp, prefix: string) => {
			let entries;
			const directoryStats = await lstat(directory).catch((error: unknown) => {
				if (isNodeError(error, "ENOENT")) return null;
				throw error;
			});
			if (directoryStats === null) return;
			if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
				blockers.push(`Abnormal pending directory: ${directory}`);
				return;
			}
			try {
				entries = await listDirectory(directory);
			} catch (error) {
				if (isNodeError(error, "ENOENT")) return;
				throw error;
			}
			for (const entry of entries) {
				const looksPending = entry.name.startsWith(prefix) && entry.name.endsWith(".tmp");
				if (!looksPending) continue;
				const pendingPath = path.join(directory, entry.name);
				if (pattern.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
					files.push(pendingPath);
				} else {
					blockers.push(`Abnormal pending node: ${pendingPath}`);
				}
			}
		};
		await scan(this.rootDir, STATE_TEMP_FILE_PATTERN, ".state.");
		await scan(this.promptsDir, BLOB_TEMP_FILE_PATTERN, ".");
		return { files: files.sort(), blockers: blockers.sort() };
	}

	private async inspectStore(includeLock = true): Promise<StoreInspection> {
		const issues: StatusIssue[] = [];
		const pendingFiles: string[] = [];
		const unreferencedBlobs: string[] = [];
		const validBlobs = new Map<string, string>();
		const abnormalPromptNodes: string[] = [];
		let state: PromptStoreStateV1 | null = null;
		let initialized = false;

		try {
			if (!(await this.rootExists())) {
				return {
					status: {
						initialized: false,
						healthy: true,
						state: null,
						activeDeployment: null,
						pendingFiles,
						unreferencedBlobs,
						issues,
					},
					validBlobs,
					abnormalPromptNodes,
				};
			}
			initialized = true;
		} catch (error) {
			issues.push({
				code: "invalid-root",
				path: this.rootDir,
				message: error instanceof Error ? error.message : `Invalid root: ${this.rootDir}`,
				blocking: true,
			});
		}

		if (issues.length === 0) {
			try {
				state = await this.readStateRequired();
			} catch (error) {
				if (!isNodeError(error instanceof Error && "cause" in error ? error.cause : error, "ENOENT")) {
					issues.push({
						code: "invalid-state",
						path: this.statePath,
						message: error instanceof Error ? error.message : `Invalid state: ${this.statePath}`,
						blocking: true,
					});
				}
			}
		}

		if (includeLock && initialized) {
			const lock = await this.inspectLock();
			if (lock.disposition !== "absent") {
				issues.push({
					code: "write-lock",
					path: this.lockPath,
					message:
						lock.message ??
						`Write lock is ${lock.disposition}: ${this.lockPath}`,
					blocking: true,
				});
			}
		}

		let entries = [] as Awaited<ReturnType<typeof listDirectory>>;
		if (issues.every((issue) => issue.code !== "invalid-root")) {
			try {
				const stats = await lstat(this.promptsDir);
				if (!stats.isDirectory() || stats.isSymbolicLink()) {
					throw new Error(`Expected a real prompts directory: ${this.promptsDir}`);
				}
				entries = await listDirectory(this.promptsDir);
			} catch (error) {
				if (!isNodeError(error, "ENOENT")) {
					issues.push({
						code: "invalid-prompts-directory",
						path: this.promptsDir,
						message: error instanceof Error ? error.message : `Invalid prompts directory: ${this.promptsDir}`,
						blocking: true,
					});
				}
			}
		}

		for (const entry of entries) {
			const entryPath = path.join(this.promptsDir, entry.name);
			const blobMatch = BLOB_FILE_PATTERN.exec(entry.name);
			if (blobMatch !== null) {
				const expectedHash = blobMatch[1];
				if (expectedHash === undefined || !entry.isFile() || entry.isSymbolicLink()) {
					abnormalPromptNodes.push(entryPath);
					issues.push({ code: "abnormal-node", path: entryPath, message: `Abnormal blob node: ${entryPath}`, blocking: true });
					continue;
				}
				try {
					const file = await readRegularUtf8(entryPath);
					if (sha256Hex(file.bytes) !== expectedHash) throw new Error(`Blob content does not match its name: ${entryPath}`);
					validBlobs.set(expectedHash, entryPath);
				} catch (error) {
					abnormalPromptNodes.push(entryPath);
					issues.push({ code: "invalid-blob", path: entryPath, message: error instanceof Error ? error.message : `Invalid blob: ${entryPath}`, blocking: true });
				}
				continue;
			}
			if (BLOB_TEMP_FILE_PATTERN.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
				pendingFiles.push(entryPath);
				issues.push({ code: "pending-file", path: entryPath, message: `Pending blob publication: ${entryPath}`, blocking: true });
				continue;
			}
			abnormalPromptNodes.push(entryPath);
			issues.push({ code: "abnormal-node", path: entryPath, message: `Abnormal prompts node: ${entryPath}`, blocking: true });
		}

		try {
			const rootEntries = await listDirectory(this.rootDir);
			for (const entry of rootEntries) {
				if (!entry.name.startsWith(".state.") || !entry.name.endsWith(".tmp")) continue;
				const entryPath = path.join(this.rootDir, entry.name);
				if (STATE_TEMP_FILE_PATTERN.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
					pendingFiles.push(entryPath);
					issues.push({ code: "pending-file", path: entryPath, message: `Pending state publication: ${entryPath}`, blocking: true });
				} else {
					issues.push({ code: "abnormal-node", path: entryPath, message: `Abnormal state temporary node: ${entryPath}`, blocking: true });
				}
			}
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
		}

		const referenced = new Set<string>();
		if (state !== null) {
			for (const deployment of state.deployments) {
				referenced.add(deployment.hash);
				const blobPath = this.blobPath(deployment.hash);
				try {
					const file = await readRegularFile(blobPath);
					if (file.bytes.byteLength !== deployment.bytes) {
						issues.push({ code: "blob-size-mismatch", path: blobPath, message: `Blob size does not match deployment ${deployment.id}: ${blobPath}`, blocking: true });
					}
					if (sha256Hex(file.bytes) !== deployment.hash) {
						issues.push({ code: "blob-hash-mismatch", path: blobPath, message: `Blob hash does not match deployment ${deployment.id}: ${blobPath}`, blocking: true });
					}
				} catch (error) {
					issues.push({
						code: isNodeError(error instanceof Error && "cause" in error ? error.cause : error, "ENOENT") ? "missing-blob" : "invalid-blob",
						path: blobPath,
						message: error instanceof Error ? error.message : `Cannot verify blob: ${blobPath}`,
						blocking: true,
					});
				}
			}
		}
		for (const [hash, blobPath] of validBlobs) {
			if (!referenced.has(hash)) {
				unreferencedBlobs.push(blobPath);
				issues.push({ code: "unreferenced-blob", path: blobPath, message: `Unreferenced valid blob: ${blobPath}`, blocking: false });
			}
		}

		const activeDeployment = state?.enabled ? state.deployments.at(-1) ?? null : null;
		return {
			status: {
				initialized,
				healthy: !issues.some((issue) => issue.blocking),
				state,
				activeDeployment,
				pendingFiles: pendingFiles.sort(),
				unreferencedBlobs: unreferencedBlobs.sort(),
				issues,
			},
			validBlobs,
			abnormalPromptNodes,
		};
	}
}

export type {
	ActivePrompt,
	BuiltinPromptSource,
	DeployResult,
	Deployment,
	ExternalPromptSource,
	DoctorResult,
	PromptInputOptions,
	PromptPreview,
	PromptSource,
	PromptStoreOptions,
	PromptStoreStateV1,
	PromptStoreStatus,
	RecoverResult,
	RecoveryLockDisposition,
	SetEnabledResult,
	StatusIssue,
	StatusIssueCode,
	UninstallResult,
} from "./types.ts";
