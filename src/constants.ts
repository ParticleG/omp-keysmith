export const STATE_SCHEMA_VERSION = 1 as const;

export const DEFAULT_PROMPT_NAME = "gpt-unrestricted";
export const SAFE_PROMPT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const STATE_FILE_NAME = "state.json";
export const PROMPTS_DIRECTORY_NAME = "prompts";
export const WRITE_LOCK_FILE_NAME = ".write.lock";
export const LOCK_OWNER = "omp-keysmith";

export const BUILTIN_GPT_UNRESTRICTED_MD = "BUILTIN_GPT_UNRESTRICTED_MD";
export const BUILTIN_PROMPT_VERSION = "0.1.1-source";
export const BUILTIN_PROMPT_COMMIT = "700f1be22446af4dc2c362080cbde669e215094d";
export const BUILTIN_PROMPT_SHA256 =
	"2c2c9f0e008c492bfc9487170a7a08daedeb8b0625af1f85617ab2d1bd3f35c0";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const BLOB_FILE_PATTERN = /^([a-f0-9]{64})\.md$/;
export const STATE_TEMP_FILE_PATTERN = /^\.state\.([1-9][0-9]*)\.([a-f0-9]{32})\.tmp$/;
export const BLOB_TEMP_FILE_PATTERN = /^\.([a-f0-9]{64})\.([1-9][0-9]*)\.([a-f0-9]{32})\.tmp$/;
