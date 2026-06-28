import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lockPathFor, upsertManagedSession } from "../src/registry.js";
import { withDirectoryLock } from "../src/lock.js";
import type { ManagedSessionRecord, MeshPaths } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCli = path.join(repoRoot, "src", "cli.ts");
const CLI_TEST_TIMEOUT_MS = 20_000;
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function meshFor(home: string): MeshPaths {
	const baseDir = path.join(home, ".pi", "agent", "pi-mesh");
	return {
		id: "local",
		baseDir,
		registryFile: path.join(baseDir, "registry.jsonl"),
		locksDir: path.join(baseDir, "locks"),
		socketDirFile: path.join(baseDir, "socket-dir"),
	};
}

async function runCli(home: string, args: string[], options: { expectFailure?: boolean } = {}) {
	const child = spawn(process.execPath, [tsxCli, sourceCli, ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const read = (stream: NodeJS.ReadableStream | null) => new Promise<string>((resolve) => {
		let out = "";
		stream?.setEncoding("utf8");
		stream?.on("data", (chunk) => {
			out += String(chunk);
		});
		stream?.on("end", () => resolve(out));
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		read(child.stdout),
		read(child.stderr),
		new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1))),
	]);
	if (!options.expectFailure && exitCode !== 0) {
		throw new Error(`pi-mesh ${args.join(" ")} failed with ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { stdout, stderr, exitCode };
}

function managedRecord(folder: string, sessionFile: string): ManagedSessionRecord {
	return {
		meshId: "managed-worker",
		name: "managed-worker",
		labels: ["dev"],
		folder,
		sessionFile,
		rawSessionId: "managed-raw-session",
		kind: "sleeping",
		status: "offline",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
	};
}

async function writePiSession(home: string, folderRoot: string): Promise<string> {
	const rawSessionId = "11111111-1111-4111-8111-111111111111";
	const sessionDir = path.join(home, ".pi", "agent", "sessions", "--tmp-pi-mesh-test--");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, `2025-01-01T00-00-00-000Z_${rawSessionId}.jsonl`);
	const entries = [
		{ type: "session", id: rawSessionId, cwd: folderRoot, timestamp: "2025-01-01T00:00:00.000Z" },
		{ type: "message", id: "u1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "unmanaged prompt", timestamp: 1 } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2025-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "unmanaged response" }],
				api: "anthropic-messages",
				provider: "openai-codex",
				model: "gpt-5.4-mini",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	return sessionFile;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sessions CLI", () => {
	it("keeps unmanaged Pi sessions out of list output unless explicitly requested", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const unmanagedSessionFile = await writePiSession(home, folderRoot);
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderRoot, path.join(folderRoot, "managed.jsonl")));

		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
		expect(listed.piSessions).toEqual([]);

		const listedWithPi = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--include-pi", "--json"])).stdout);
		expect(listedWithPi.piSessions.map((item: { path: string }) => item.path)).toContain(unmanagedSessionFile);
	}, CLI_TEST_TIMEOUT_MS);

	it("filters central sessions by folder, name, and label", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderA = await realpath(await makeTempDir("pi-mesh-cli-folder-a-"));
		const folderB = await realpath(await makeTempDir("pi-mesh-cli-folder-b-"));
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderA, path.join(folderA, "one.jsonl")));
		await upsertManagedSession(mesh, { ...managedRecord(folderB, path.join(folderB, "two.jsonl")), meshId: "other-worker", rawSessionId: "other-raw", labels: ["other"] });

		const byFolder = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderA, "--json"])).stdout);
		expect(byFolder.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);

		const byLabel = JSON.parse((await runCli(home, ["sessions", "list", "--label", "dev", "--json"])).stdout);
		expect(byLabel.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
	}, CLI_TEST_TIMEOUT_MS);

	it("deletes a managed session from the registry while keeping the session file by default", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		await writeFile(sessionFile, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), pid: process.pid });

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--json"]);
		const payload = JSON.parse(result.stdout);

		expect(payload.ok).toBe(true);
		expect(payload.deleted.meshId).toBe("managed-worker");
		expect(payload.deletedFile).toBe(false);
		await expect(access(sessionFile)).resolves.toBeUndefined();
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed).toEqual([]);
	}, CLI_TEST_TIMEOUT_MS);

	it("requires confirmation before deleting the underlying session file", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		await writeFile(sessionFile, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderRoot, sessionFile));

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--delete-file"], { expectFailure: true });

		expect(result.stderr).toContain("--delete-file requires an interactive terminal");
		await expect(access(sessionFile)).resolves.toBeUndefined();
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
	}, CLI_TEST_TIMEOUT_MS);

	it("can delete the underlying session file with force", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		await writeFile(sessionFile, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderRoot, sessionFile));

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--delete-file", "--force", "--json"]);
		const payload = JSON.parse(result.stdout);

		expect(payload.deletedFile).toBe(true);
		await expect(access(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
	}, CLI_TEST_TIMEOUT_MS);

	it("reports no deleted file when the underlying session file is already absent", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "missing.jsonl");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderRoot, sessionFile));

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--delete-file", "--force", "--json"]);
		const payload = JSON.parse(result.stdout);

		expect(payload.deletedFile).toBe(false);
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed).toEqual([]);
	}, CLI_TEST_TIMEOUT_MS);

	it("refuses to delete a live managed session", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		const socketPath = path.join(folderRoot, "managed.sock");
		await writeFile(sessionFile, "", "utf8");
		await writeFile(socketPath, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), status: "running", pid: process.pid, socketPath });

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--delete-file", "--force"], { expectFailure: true });

		expect(result.stderr).toContain("already active");
		expect(result.stderr).toContain("before deleting it");
		await expect(access(sessionFile)).resolves.toBeUndefined();
		await expect(access(socketPath)).resolves.toBeUndefined();
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
	}, CLI_TEST_TIMEOUT_MS);

	it("refuses force deletion for a live managed session", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		const socketPath = path.join(folderRoot, "managed.sock");
		await writeFile(sessionFile, "", "utf8");
		await writeFile(socketPath, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), status: "running", pid: process.pid, socketPath });

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--force"], { expectFailure: true });

		expect(result.stderr).toContain("already active");
		expect(result.stderr).toContain("before deleting it");
		await expect(access(sessionFile)).resolves.toBeUndefined();
		await expect(access(socketPath)).resolves.toBeUndefined();
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
	}, CLI_TEST_TIMEOUT_MS);

	it("refuses to delete an error-status session while its process or socket is still active", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		const socketPath = path.join(folderRoot, "managed.sock");
		await writeFile(sessionFile, "", "utf8");
		await writeFile(socketPath, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), status: "error", pid: process.pid, socketPath });

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--delete-file", "--force"], { expectFailure: true });

		expect(result.stderr).toContain("already active");
		expect(result.stderr).toContain("before deleting it");
		await expect(access(sessionFile)).resolves.toBeUndefined();
		await expect(access(socketPath)).resolves.toBeUndefined();
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
	}, CLI_TEST_TIMEOUT_MS);

	it("deletes an error-status session after active process and socket evidence are gone", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		const socketPath = path.join(folderRoot, "managed.sock");
		await writeFile(sessionFile, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), status: "error", pid: undefined, socketPath });

		const result = await runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--delete-file", "--force", "--json"]);
		const payload = JSON.parse(result.stdout);

		expect(payload.deletedFile).toBe(true);
		await expect(access(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed).toEqual([]);
	}, CLI_TEST_TIMEOUT_MS);

	it("waits for in-flight session writes before deleting the registry entry", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		await writeFile(sessionFile, "", "utf8");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderRoot, sessionFile));

		let deletePromise: Promise<Awaited<ReturnType<typeof runCli>>> | undefined;
		await withDirectoryLock(lockPathFor(mesh, "managed-worker"), async () => {
			deletePromise = runCli(home, ["sessions", "delete", "managed-worker", "--folder", folderRoot, "--json"]);
			await sleep(500);
			await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), status: "offline", lastError: "final in-flight write" });
		});

		const result = await deletePromise;
		expect(JSON.parse(result!.stdout).deleted.meshId).toBe("managed-worker");
		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--folder", folderRoot, "--json"])).stdout);
		expect(listed.managed).toEqual([]);
	}, CLI_TEST_TIMEOUT_MS);

	it("requires an explicit broadcast when a send selector matches multiple sessions", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderA = await realpath(await makeTempDir("pi-mesh-cli-folder-a-"));
		const folderB = await realpath(await makeTempDir("pi-mesh-cli-folder-b-"));
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, managedRecord(folderA, path.join(folderA, "one.jsonl")));
		await upsertManagedSession(mesh, { ...managedRecord(folderB, path.join(folderB, "two.jsonl")), meshId: "second-worker", rawSessionId: "second-raw" });

		const result = await runCli(home, ["send", "managed-worker", "hello"], { expectFailure: true });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Multiple managed sessions match");
		expect(result.stderr).toContain("--all");
	}, CLI_TEST_TIMEOUT_MS);

	it("checks attach live-session ownership before applying replacement metadata", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const otherFolder = await realpath(await makeTempDir("pi-mesh-cli-other-folder-"));
		const sessionFile = path.join(folderRoot, "managed.jsonl");
		const mesh = meshFor(home);
		await upsertManagedSession(mesh, { ...managedRecord(folderRoot, sessionFile), status: "running", pid: process.pid });

		const result = await runCli(home, ["attach", sessionFile, "--name", "renamed", "--folder", otherFolder, "--label", "new-label"], { expectFailure: true });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("already active");
	}, CLI_TEST_TIMEOUT_MS);

	it("gives attach guidance when sending to an unmanaged readable Pi session", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const folderRoot = await realpath(await makeTempDir("pi-mesh-cli-folder-"));
		const unmanagedSessionFile = await writePiSession(home, folderRoot);

		const result = await runCli(home, ["send", unmanagedSessionFile, "hello", "--folder", folderRoot], { expectFailure: true });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Session is readable but not managed");
		expect(result.stderr).toContain("pi-mesh attach");
	}, CLI_TEST_TIMEOUT_MS);
});
