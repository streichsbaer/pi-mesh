import { promises as fs } from "node:fs";
import path from "node:path";

export interface LockOptions {
	staleMs?: number;
	waitMs?: number;
	pollMs?: number;
	heartbeatMs?: number;
}

interface LockOwner {
	pid?: number;
	createdAt?: string;
}

const DEFAULT_STALE_MS = 20 * 60 * 1000;
const DEFAULT_WAIT_MS = 60 * 1000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 5_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")) as LockOwner;
	} catch {
		return null;
	}
}

async function touchLock(lockDir: string): Promise<void> {
	const now = new Date();
	await fs.utimes(lockDir, now, now).catch(() => undefined);
	await fs.utimes(path.join(lockDir, "owner.json"), now, now).catch(() => undefined);
}

async function removeIfStale(lockDir: string, staleMs: number): Promise<void> {
	const stat = await fs.stat(lockDir).catch(() => null);
	if (!stat) return;
	if (Date.now() - stat.mtimeMs <= staleMs) return;

	const owner = await readOwner(lockDir);
	if (isProcessAlive(owner?.pid)) {
		await touchLock(lockDir);
		return;
	}

	await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
}

export async function withDirectoryLock<T>(
	lockDir: string,
	fn: () => Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const heartbeatMs = Math.max(1_000, Math.min(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, Math.max(1_000, staleMs / 3)));
	const started = Date.now();
	let heartbeat: NodeJS.Timeout | undefined;

	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		await removeIfStale(lockDir, staleMs);
		try {
			await fs.mkdir(lockDir);
			await fs.writeFile(
				path.join(lockDir, "owner.json"),
				JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
				"utf8",
			);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (Date.now() - started > waitMs) throw new Error(`Timed out waiting for lock: ${lockDir}`);
			await sleep(pollMs);
		}
	}

	heartbeat = setInterval(() => {
		void touchLock(lockDir);
	}, heartbeatMs);

	try {
		return await fn();
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
