export interface BuiltinPromptSource {
	kind: "builtin";
	symbol: "BUILTIN_GPT_UNRESTRICTED_MD";
	version: "0.1.1-source";
	commit: "700f1be22446af4dc2c362080cbde669e215094d";
}

export interface ExternalPromptSource {
	kind: "external";
	path: string;
}

export type PromptSource = BuiltinPromptSource | ExternalPromptSource;

export interface Deployment {
	id: string;
	name: string;
	hash: string;
	bytes: number;
	source: PromptSource;
	deployedAt: string;
	enabledBefore: boolean;
}

export interface PromptStoreStateV1 {
	version: 1;
	enabled: boolean;
	deployments: Deployment[];
}

export interface PromptInputOptions {
	name?: string;
	externalPath?: string;
}

export interface PromptPreview {
	name: string;
	hash: string;
	bytes: number;
	content: string;
	source: PromptSource;
}

export type StatusIssueCode =
	| "invalid-root"
	| "invalid-prompts-directory"
	| "invalid-state"
	| "missing-blob"
	| "invalid-blob"
	| "blob-size-mismatch"
	| "blob-hash-mismatch"
	| "pending-file"
	| "abnormal-node"
	| "write-lock"
	| "unreferenced-blob";

export interface StatusIssue {
	code: StatusIssueCode;
	path: string;
	message: string;
	blocking: boolean;
}

export interface PromptStoreStatus {
	initialized: boolean;
	healthy: boolean;
	state: PromptStoreStateV1 | null;
	activeDeployment: Deployment | null;
	pendingFiles: string[];
	unreferencedBlobs: string[];
	issues: StatusIssue[];
}

export interface DeployResult {
	deployment: Deployment;
	state: PromptStoreStateV1;
	blobCreated: boolean;
}

export interface SetEnabledResult {
	changed: boolean;
	state: PromptStoreStateV1;
}

export interface UninstallResult {
	removed: Deployment;
	state: PromptStoreStateV1;
}

export type RecoveryLockDisposition =
	| "absent"
	| "stale-same-host"
	| "live-same-host"
	| "foreign-host"
	| "abnormal";

export interface RecoverResult {
	apply: boolean;
	lockDisposition: RecoveryLockDisposition;
	lockPath: string | null;
	pendingFiles: string[];
	removed: string[];
	blockers: string[];
}

export interface DoctorResult {
	fix: boolean;
	unreferencedBlobs: string[];
	removed: string[];
	blockers: string[];
}

export interface ActivePrompt {
	content: string;
	deployment: Deployment;
}

export interface PromptStoreOptions {
	rootDir: string;
	builtinAssetPath: string;
}
