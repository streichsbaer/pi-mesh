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
import type { ManagedSessionRecord, MeshPaths } from "../src/types.js";

const tempDirs: string[] = [];

async function tempMesh(): Promise<MeshPaths> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "pi-mesh-registry-"));
	tempDirs.push(baseDir);
	return {
		id: "local",
		baseDir,
		registryFile: path.join(baseDir, "registry.jsonl"),
		locksDir: path.join(baseDir, "locks"),
		socketDirFile: path.join(baseDir, "socket-dir"),
	};
}

function record(meshId: string, patch: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
	return {
		meshId,
		name: meshId,
		folder: "/tmp/project",
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
		if (socketDir) await rm(socketDir, { recursive: true, force: true });
		await rm(dir, { recursive: true, force: true });
	}));
});

describe("registry", () => {
	it("normalizes mesh ids for agent-friendly names", () => {
		expect(normalizeMeshId(" Worker API / Auth Tests! ")).toBe("worker-api-auth-tests");
		expect(normalizeMeshId("---Already.OK---")).toBe("already.ok");
	});

	it("derives stable mesh ids from session identity", () => {
		expect(createMeshId({ folder: "/tmp/project", rawSessionId: "raw-session-id" })).toBe(createMeshId({ folder: "/elsewhere", rawSessionId: "raw-session-id" }));
		expect(createMeshId({ folder: "/tmp/project", sessionFile: "/tmp/session.jsonl" })).toMatch(/^session-[a-f0-9]{12}$/);
	});

	it("appends upserts and resolves the latest record by multiple identifiers", async () => {
		const mesh = await tempMesh();
		await upsertManagedSession(mesh, record("worker", { status: "offline" }));
		const latest = await upsertManagedSession(mesh, record("worker", { status: "running", socketPath: "/tmp/worker.sock" }));
		await upsertManagedSession(mesh, record("other", { rawSessionId: "raw-other" }));

		const sessions = await listManagedSessions(mesh);
		expect(sessions).toHaveLength(2);
		expect(sessions.map((item) => item.meshId).sort()).toEqual(["other", "worker"]);
		expect(sessions.find((item) => item.meshId === "worker")).toMatchObject({ meshId: "worker", status: "running", socketPath: "/tmp/worker.sock" });

		await expect(findManagedSession(mesh, "worker")).resolves.toMatchObject(latest);
		await expect(findManagedSession(mesh, "Worker")).resolves.toMatchObject(latest);
		await expect(findManagedSession(mesh, latest.sessionFile)).resolves.toMatchObject(latest);
		await expect(findManagedSession(mesh, latest.rawSessionId!)).resolves.toMatchObject(latest);
	});

	it("coalesces records that point at the same underlying session", async () => {
		const mesh = await tempMesh();
		await upsertManagedSession(mesh, record("first", { sessionFile: "/tmp/shared.jsonl", name: "worker" }));
		await upsertManagedSession(mesh, record("second", { sessionFile: "/tmp/shared.jsonl", name: "renamed", labels: ["dev"] }));

		const sessions = await listManagedSessions(mesh);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ meshId: "first", name: "renamed", labels: ["dev"] });
	});

	it("derives hashed socket paths and normalized lock paths", async () => {
		const mesh = await tempMesh();
		const socketPath = await socketPathFor(mesh, "Worker API");

		expect(path.basename(path.dirname(socketPath))).toMatch(/^pi-mesh-/);
		expect(path.basename(socketPath)).toMatch(/^[a-f0-9]{20}\.sock$/);
		expect(socketPath).not.toContain("worker-api");
		expect(lockPathFor(mesh, "Worker API")).toBe(path.join(mesh.locksDir, "worker-api.lock"));
	});

	it("keeps socket paths short for long mesh ids", async () => {
		const mesh = await tempMesh();
		const socketPath = await socketPathFor(mesh, "worker-".repeat(30));

		expect(socketPath.length).toBeLessThan(104);
		expect(path.basename(socketPath)).toMatch(/^[a-f0-9]{20}\.sock$/);
	});
});
