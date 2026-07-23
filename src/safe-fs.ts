import { createHash, randomBytes } from "node:crypto";
import {
	chmod,
	constants as fsConstants,
	lstat,
	link,
	mkdir,
	open,
	readdir,
	rename,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import {
	PRIVATE_DIRECTORY_MODE,
	PRIVATE_FILE_MODE,
} from "./constants.ts";

export interface FileIdentity {
	dev: number;
	ino: number;
}

export interface RegularFile {
	bytes: Uint8Array;
	identity: FileIdentity;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function decodeUtf8(bytes: Uint8Array, filePath: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (error) {
		throw new Error(`File is not valid UTF-8: ${filePath}`, { cause: error });
	}
}

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
	await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	const stats = await lstat(directoryPath);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Expected a real directory: ${directoryPath}`);
	}
	await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export async function readRegularFile(filePath: string): Promise<RegularFile> {
	const pathStats = await lstat(filePath);
	if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
		throw new Error(`Expected a regular file without following links: ${filePath}`);
	}

	let handle;
	try {
		handle = await open(
			filePath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
		);
	} catch (error) {
		throw new Error(`Cannot open regular file without following links: ${filePath}`, {
			cause: error,
		});
	}

	try {
		const before = await handle.stat();
		if (
			!before.isFile() ||
			before.dev !== pathStats.dev ||
			before.ino !== pathStats.ino ||
			before.size !== pathStats.size ||
			before.mtimeMs !== pathStats.mtimeMs
		) {
			throw new Error(`File changed while opening: ${filePath}`);
		}
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			bytes.byteLength !== before.size
		) {
			throw new Error(`File changed while reading: ${filePath}`);
		}
		return {
			bytes,
			identity: { dev: before.dev, ino: before.ino },
		};
	} finally {
		await handle.close();
	}
}

export async function readRegularUtf8(filePath: string): Promise<{
	content: string;
	bytes: Uint8Array;
	identity: FileIdentity;
}> {
	const file = await readRegularFile(filePath);
	return {
		content: decodeUtf8(file.bytes, filePath),
		bytes: file.bytes,
		identity: file.identity,
	};
}

export function randomToken(): string {
	return randomBytes(16).toString("hex");
}

export async function writeExclusiveFile(
	filePath: string,
	bytes: Uint8Array | string,
): Promise<FileIdentity> {
	const handle = await open(
		filePath,
		fsConstants.O_WRONLY |
			fsConstants.O_CREAT |
			fsConstants.O_EXCL |
			fsConstants.O_NOFOLLOW,
		PRIVATE_FILE_MODE,
	);
	let succeeded = false;
	try {
		await handle.writeFile(bytes);
		await handle.sync();
		const stats = await handle.stat();
		succeeded = true;
		return { dev: stats.dev, ino: stats.ino };
	} finally {
		await handle.close();
		if (!succeeded) {
			await unlink(filePath).catch(() => undefined);
		}
	}
}

export async function fsyncDirectory(directoryPath: string): Promise<void> {
	const handle = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function publishTempFile(
	tempPath: string,
	destinationPath: string,
	bytes: Uint8Array | string,
): Promise<void> {
	await writeExclusiveFile(tempPath, bytes);
	try {
		await rename(tempPath, destinationPath);
		await fsyncDirectory(path.dirname(destinationPath));
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export async function publishImmutableTempFile(
	tempPath: string,
	destinationPath: string,
	bytes: Uint8Array | string,
): Promise<void> {
	await writeExclusiveFile(tempPath, bytes);
	try {
		await link(tempPath, destinationPath);
		await unlink(tempPath);
		await fsyncDirectory(path.dirname(destinationPath));
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export async function removeExactRegularFile(
	filePath: string,
	expected?: FileIdentity,
): Promise<void> {
	const file = await readRegularFile(filePath);
	if (
		expected !== undefined &&
		(file.identity.dev !== expected.dev || file.identity.ino !== expected.ino)
	) {
		throw new Error(`File changed before cleanup: ${filePath}`);
	}
	const current = await lstat(filePath);
	if (
		!current.isFile() ||
		current.isSymbolicLink() ||
		current.dev !== file.identity.dev ||
		current.ino !== file.identity.ino
	) {
		throw new Error(`File changed before cleanup: ${filePath}`);
	}
	await unlink(filePath);
	await fsyncDirectory(path.dirname(filePath));
}

export async function listDirectory(directoryPath: string) {
	return readdir(directoryPath, { withFileTypes: true });
}
