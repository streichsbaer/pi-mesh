import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMeshId,
	findManagedSession,
	listManagedSessions,
	lockPathFor,
	normalizeMeshId,
	socketPathFor,
	upsertManagedSession,
} from "../src/registry.js";
import type { ManagedSessionRecord, WorkspacePaths } from "../src/types.js";

const tempDirs: string[] = [];

async function tempWorkspace(): Promise<WorkspacePaths> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "pi-mesh-registry-"));
	tempDirs.push(baseDir);
	return {
		id: "test-workspace",
		root: baseDir,
		baseDir,
		registryFile: path.join(baseDir, "registry.jsonl"),
		inboxDir: path.join(baseDir, "inbox"),
		locksDir: path.join(baseDir, "locks"),
	};
}

function record(meshId: string, patch: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
	return {
		meshId,
		name: meshId,
		cwd: "/tmp/project",
		sessionFile: `/tmp/${meshId}.jsonl`,
		rawSessionId: `${meshId}-raw`,
		kind: "sleeping",
		status: "offline",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		...patch,
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(async (dir) => {
		const socketDir = (await readFile(path.join(dir, "socket-dir"), "utf8").catch(() => "")).trim();
		if (socketDir) await rm(path.dirname(socketDir), { recursive: true, force: true });
		await rm(dir, { recursive: true, force: true });
	}));
});

describe("registry", () => {
	it("normalizes mesh ids for agent-friendly names", () => {
		expect(normalizeMeshId(" Worker API / Auth Tests! ")).toBe("worker-api-auth-tests");
		expect(normalizeMeshId("---Already.OK---")).toBe("already.ok");
	});

	it("prefers normalized names for explicit mesh ids", () => {
		expect(createMeshId({ name: "Worker API", cwd: "/tmp/project" })).toBe("worker-api");
		expect(createMeshId({ name: "   ", cwd: "/tmp/project", sessionFile: "/tmp/session.jsonl" })).toMatch(/^session-[a-f0-9]{10}$/);
	});

	it("appends upserts and resolves the latest record by multiple identifiers", async () => {
		const workspace = await tempWorkspace();
		await upsertManagedSession(workspace, record("worker", { status: "offline" }));
		const latest = await upsertManagedSession(workspace, record("worker", { status: "running", socketPath: "/tmp/worker.sock" }));
		await upsertManagedSession(workspace, record("other", { rawSessionId: "raw-other" }));

		const sessions = await listManagedSessions(workspace);
		expect(sessions).toHaveLength(2);
		expect(sessions.map((item) => item.meshId).sort()).toEqual(["other", "worker"]);
		expect(sessions.find((item) => item.meshId === "worker")).toMatchObject({ meshId: "worker", status: "running", socketPath: "/tmp/worker.sock" });

		await expect(findManagedSession(workspace, "worker")).resolves.toMatchObject(latest);
		await expect(findManagedSession(workspace, "Worker")).resolves.toMatchObject(latest);
		await expect(findManagedSession(workspace, latest.sessionFile)).resolves.toMatchObject(latest);
		await expect(findManagedSession(workspace, latest.rawSessionId!)).resolves.toMatchObject(latest);
	});

	it("derives hashed socket paths and normalized lock paths", async () => {
		const workspace = await tempWorkspace();
		const socketPath = await socketPathFor(workspace, "Worker API");

		expect(path.basename(path.dirname(path.dirname(socketPath)))).toMatch(/^pi-mesh-/);
		expect(path.basename(socketPath)).toMatch(/^[a-f0-9]{20}\.sock$/);
		expect(socketPath).not.toContain("worker-api");
		expect(lockPathFor(workspace, "Worker API")).toBe(path.join(workspace.locksDir, "worker-api.lock"));
	});

	it("keeps socket paths short for long mesh ids", async () => {
		const workspace = { ...(await tempWorkspace()), id: "1234567890abcdef" };
		const socketPath = await socketPathFor(workspace, "worker-".repeat(30));

		expect(socketPath.length).toBeLessThan(104);
		expect(path.basename(socketPath)).toMatch(/^[a-f0-9]{20}\.sock$/);
	});
});
