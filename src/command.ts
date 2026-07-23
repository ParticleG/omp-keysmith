export type KeysmithCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "preview"; file?: string; name?: string }
	| { kind: "deploy"; file?: string; name?: string; yes: boolean; dryRun: boolean }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "uninstall"; yes: boolean }
	| { kind: "recover"; yes: boolean }
	| { kind: "doctor"; fix: boolean; yes: boolean };

interface ParsedArguments {
	positional: string[];
	flags: Map<string, string | boolean>;
}

const VALUE_FLAGS: Record<string, true> = {
	file: true,
	name: true,
};
const BOOLEAN_FLAGS: Record<string, true> = {
	"dry-run": true,
	fix: true,
	yes: true,
};
const SHORT_FLAGS: Record<string, string> = {
	f: "file",
	n: "name",
	y: "yes",
};

function tokenize(raw: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const character of raw.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (escaped) throw new Error("Trailing escape character in command arguments");
	if (quote) throw new Error("Unterminated quoted argument");
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function normalizeFlag(token: string): { name: string; inlineValue?: string } | undefined {
	if (token.startsWith("--")) {
		const body = token.slice(2);
		const equals = body.indexOf("=");
		return equals === -1
			? { name: body }
			: { name: body.slice(0, equals), inlineValue: body.slice(equals + 1) };
	}
	if (token.startsWith("-") && token.length === 2) {
		const name = SHORT_FLAGS[token.slice(1)];
		if (!name) throw new Error(`Unknown option: ${token}`);
		return { name };
	}
	return undefined;
}

function parseArguments(tokens: string[]): ParsedArguments {
	const positional: string[] = [];
	const flags = new Map<string, string | boolean>();
	let optionsEnded = false;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		const flag = optionsEnded ? undefined : normalizeFlag(token);
		if (!flag) {
			positional.push(token);
			continue;
		}
		if (!VALUE_FLAGS[flag.name] && !BOOLEAN_FLAGS[flag.name]) {
			throw new Error(`Unknown option: --${flag.name}`);
		}
		if (flags.has(flag.name)) throw new Error(`Duplicate option: --${flag.name}`);
		if (BOOLEAN_FLAGS[flag.name]) {
			if (flag.inlineValue !== undefined) throw new Error(`--${flag.name} does not accept a value`);
			flags.set(flag.name, true);
			continue;
		}
		const value = flag.inlineValue ?? tokens[++index];
		if (!value || normalizeFlag(value)) throw new Error(`--${flag.name} requires a value`);
		flags.set(flag.name, value);
	}

	return { positional, flags };
}


function rejectFlags(args: ParsedArguments, allowed: readonly string[]): void {
	for (const name of args.flags.keys()) {
		if (!allowed.includes(name)) throw new Error(`--${name} is not valid for this command`);
	}
}

function sourceOptions(args: ParsedArguments): { file?: string; name?: string } {
	if (args.positional.length > 1) throw new Error("Only one prompt file may be specified");
	const rawFlagFile = args.flags.get("file");
	const flagFile = typeof rawFlagFile === "string" ? rawFlagFile : undefined;
	if (flagFile && args.positional[0]) throw new Error("Specify the prompt path either positionally or with --file, not both");
	const file = flagFile ?? args.positional[0];
	const rawName = args.flags.get("name");
	const name = typeof rawName === "string" ? rawName : undefined;
	return {
		...(file ? { file } : {}),
		...(name ? { name } : {}),
	};
}

export function parseKeysmithCommand(raw: string): KeysmithCommand {
	const tokens = tokenize(raw);
	const command = tokens.shift()?.toLowerCase() ?? "help";
	const args = parseArguments(tokens);

	switch (command) {
		case "help":
		case "usage":
			rejectFlags(args, []);
			if (args.positional.length > 0) throw new Error("help does not accept arguments");
			return { kind: "help" };
		case "status":
			rejectFlags(args, []);
			if (args.positional.length > 0) throw new Error("status does not accept arguments");
			return { kind: "status" };
		case "preview":
		case "dry-run":
			rejectFlags(args, ["file", "name"]);
			return { kind: "preview", ...sourceOptions(args) };
		case "deploy":
			rejectFlags(args, ["dry-run", "file", "name", "yes"]);
			return {
				kind: "deploy",
				...sourceOptions(args),
				yes: args.flags.get("yes") === true,
				dryRun: args.flags.get("dry-run") === true,
			};
		case "enable":
		case "disable":
			rejectFlags(args, []);
			if (args.positional.length > 0) throw new Error(`${command} does not accept arguments`);
			return { kind: command };
		case "uninstall":
		case "rollback":
			rejectFlags(args, ["yes"]);
			if (args.positional.length > 0) throw new Error(`${command} does not accept arguments`);
			return { kind: "uninstall", yes: args.flags.get("yes") === true };
		case "recover":
			rejectFlags(args, ["yes"]);
			if (args.positional.length > 0) throw new Error("recover does not accept arguments");
			return { kind: "recover", yes: args.flags.get("yes") === true };
		case "doctor":
			rejectFlags(args, ["fix", "yes"]);
			if (args.positional.length > 0) throw new Error("doctor does not accept arguments");
			return { kind: "doctor", fix: args.flags.get("fix") === true, yes: args.flags.get("yes") === true };
		default:
			throw new Error(`Unknown keysmith command: ${command}`);
	}
}

export function keysmithUsage(): string {
	return [
		"Keysmith commands",
		"  /keysmith status",
		"  /keysmith preview [--file <path>] [--name <name>]",
		"  /keysmith deploy [--file <path>] [--name <name>] [--dry-run] [--yes]",
		"  /keysmith enable | disable",
		"  /keysmith uninstall [--yes]",
		"  /keysmith recover [--yes]",
		"  /keysmith doctor [--fix] [--yes]",
		"",
		"Persistent lifecycle",
		"  deploy: push a new deployment layer and enable it; omit --file for the bundled prompt.",
		"  disable: stop injection persistently across turns and sessions, while retaining all layers.",
		"  enable: resume the selected layer without creating a new deployment.",
		"  uninstall: pop only the newest deployment layer and restore its previous enabled state.",
		"",
		"Package removal",
		"  /keysmith uninstall does not uninstall the OMP plugin.",
		"  Run `omp plugin uninstall omp-keysmith` in a shell to remove the Extension package.",
		"",
		"Aliases: /keysmith dry-run = preview; /keysmith rollback = uninstall.",
	].join("\n");
}
