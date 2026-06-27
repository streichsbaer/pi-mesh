import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { upsertManagedSession } from "../src/registry.js";
import type { ManagedSessionRecord, WorkspacePaths } from "../src/types.js";
import { stableId } from "../src/utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCli = path.join(repoRoot, "src", "cli.ts");
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function workspaceFor(home: string, root: string): WorkspacePaths {
	const id = stableId(root);
	const baseDir = path.join(home, ".pi", "agent", "pi-mesh", "workspaces", id);
	return {
		id,
		root,
		baseDir,
		registryFile: path.join(baseDir, "registry.jsonl"),
		inboxDir: path.join(baseDir, "inbox"),
		locksDir: path.join(baseDir, "locks"),
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

function managedRecord(workspaceRoot: string, sessionFile: string): ManagedSessionRecord {
	return {
		meshId: "managed-worker",
		name: "managed-worker",
		cwd: workspaceRoot,
		sessionFile,
		rawSessionId: "managed-raw-session",
		kind: "sleeping",
		status: "offline",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
	};
}

async function writePiSession(home: string, workspaceRoot: string): Promise<string> {
	const rawSessionId = "11111111-1111-4111-8111-111111111111";
	const sessionDir = path.join(home, ".pi", "agent", "sessions", "--tmp-pi-mesh-test--");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, `2025-01-01T00-00-00-000Z_${rawSessionId}.jsonl`);
	const entries = [
		{ type: "session", id: rawSessionId, cwd: workspaceRoot, timestamp: "2025-01-01T00:00:00.000Z" },
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
		const workspaceRoot = await makeTempDir("pi-mesh-cli-workspace-");
		const unmanagedSessionFile = await writePiSession(home, workspaceRoot);
		const workspace = workspaceFor(home, workspaceRoot);
		await upsertManagedSession(workspace, managedRecord(workspaceRoot, path.join(workspaceRoot, "managed.jsonl")));

		const listed = JSON.parse((await runCli(home, ["sessions", "list", "--workspace", workspaceRoot, "--json"])).stdout);
		expect(listed.managed.map((item: ManagedSessionRecord) => item.meshId)).toEqual(["managed-worker"]);
		expect(listed.piSessions).toEqual([]);

		const listedWithPi = JSON.parse((await runCli(home, ["sessions", "list", "--workspace", workspaceRoot, "--include-pi", "--json"])).stdout);
		expect(listedWithPi.piSessions.map((item: { path: string }) => item.path)).toContain(unmanagedSessionFile);
	});

	it("gives attach guidance when sending to an unmanaged readable Pi session", async () => {
		const home = await makeTempDir("pi-mesh-cli-home-");
		const workspaceRoot = await makeTempDir("pi-mesh-cli-workspace-");
		const unmanagedSessionFile = await writePiSession(home, workspaceRoot);

		const result = await runCli(home, ["send", unmanagedSessionFile, "hello", "--workspace", workspaceRoot], { expectFailure: true });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Session is readable but not managed");
		expect(result.stderr).toContain("pi-mesh attach");
	});
});
