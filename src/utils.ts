import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function homeDir(): string {
	return os.homedir();
}

export function expandHome(value: string): string {
	if (value === "~") return homeDir();
	if (value.startsWith("~/")) return path.join(homeDir(), value.slice(2));
	return value;
}

export function piAgentDir(): string {
	return path.join(homeDir(), ".pi", "agent");
}

export async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

export async function ensurePrivateDir(dir: string): Promise<void> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await fs.mkdir(dir, { mode: 0o700 });
		stat = await fs.lstat(dir);
	}
	if (stat.isSymbolicLink()) throw new Error(`${dir} must not be a symbolic link`);
	if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`${dir} is not owned by the current user`);
	}
	if ((stat.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
}

export function userRuntimeId(): string {
	if (typeof process.getuid === "function") return String(process.getuid());
	return stableId(homeDir(), 8);
}

export function socketRuntimePrefix(): string {
	const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
	return path.join(base, `pi-mesh-${userRuntimeId()}-`);
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function safeJson<T = unknown>(line: string, fallback: T): T {
	try {
		return JSON.parse(line) as T;
	} catch {
		return fallback;
	}
}

export async function walkFiles(
	root: string,
	predicate: (filePath: string) => boolean = () => true,
	out: string[] = [],
): Promise<string[]> {
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) await walkFiles(full, predicate, out);
		else if (entry.isFile() && predicate(full)) out.push(full);
	}
	return out;
}

export function compactWhitespace(text: string): string {
	return String(text || "").replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max = 220): string {
	const value = String(text || "").trim();
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function formatTimestamp(msOrIso: number | string | null | undefined): string {
	if (!msOrIso) return "n/a";
	if (typeof msOrIso === "string") return msOrIso;
	try {
		return new Date(msOrIso).toISOString();
	} catch {
		return String(msOrIso);
	}
}

export function stableId(value: string, length = 16): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export async function findGitRoot(startCwd: string): Promise<string | null> {
	let current = path.resolve(startCwd);
	while (true) {
		if (await exists(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function parseDuration(value: string): number | null {
	const text = String(value || "").trim();
	if (!text) return null;
	if (/^\d+$/.test(text)) return Number(text);
	const matches = [...text.matchAll(/(\d+)(ms|s|m|h|d|w)/g)];
	if (!matches.length || matches.map((m) => m[0]).join("") !== text) return null;

	let total = 0;
	for (const [, rawNum, unit] of matches) {
		const n = Number(rawNum);
		if (unit === "ms") total += n;
		if (unit === "s") total += n * 1000;
		if (unit === "m") total += n * 60 * 1000;
		if (unit === "h") total += n * 60 * 60 * 1000;
		if (unit === "d") total += n * 24 * 60 * 60 * 1000;
		if (unit === "w") total += n * 7 * 24 * 60 * 60 * 1000;
	}
	return total;
}

export function parseTimeSpec(value: string, now = Date.now()): number | null {
	const text = String(value || "").trim();
	if (!text) return null;
	const duration = parseDuration(text);
	if (duration !== null) return now - duration;
	if (/^\d{10,13}$/.test(text)) {
		const num = Number(text);
		return text.length === 10 ? num * 1000 : num;
	}
	const parsed = Date.parse(text);
	return Number.isFinite(parsed) ? parsed : null;
}
