import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSessionRecord, WorkspacePaths } from "./types.js";
import { compactWhitespace, safeJson, stableId } from "./utils.js";

interface RegistryEvent {
	type: "upsert" | "delete";
	record?: ManagedSessionRecord;
	meshId?: string;
	timestamp: string;
}

export function normalizeMeshId(nameOrId: string): string {
	return compactWhitespace(nameOrId)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export function createMeshId(input: { name?: string; cwd: string; sessionFile?: string }): string {
	if (input.name) {
		const normalized = normalizeMeshId(input.name);
		if (normalized) return normalized;
	}
	return `session-${stableId(`${input.cwd}:${input.sessionFile || Date.now()}`, 10)}`;
}

async function appendRegistryEvent(workspace: WorkspacePaths, event: RegistryEvent): Promise<void> {
	await fs.mkdir(path.dirname(workspace.registryFile), { recursive: true });
	await fs.appendFile(workspace.registryFile, `${JSON.stringify(event)}\n`, "utf8");
}

export async function listManagedSessions(workspace: WorkspacePaths): Promise<ManagedSessionRecord[]> {
	const text = await fs.readFile(workspace.registryFile, "utf8").catch(() => "");
	const byId = new Map<string, ManagedSessionRecord>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const event = safeJson<RegistryEvent | null>(line, null);
		if (!event) continue;
		if (event.type === "delete" && event.meshId) byId.delete(event.meshId);
		if (event.type === "upsert" && event.record?.meshId) byId.set(event.record.meshId, event.record);
	}
	return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function findManagedSession(
	workspace: WorkspacePaths,
	spec: string,
): Promise<ManagedSessionRecord | undefined> {
	const normalized = normalizeMeshId(spec);
	const records = await listManagedSessions(workspace);
	return records.find(
		(record) =>
			record.meshId === spec ||
			record.meshId === normalized ||
			record.name === spec ||
			record.sessionFile === spec ||
			record.rawSessionId === spec,
	);
}

export async function upsertManagedSession(
	workspace: WorkspacePaths,
	record: ManagedSessionRecord,
): Promise<ManagedSessionRecord> {
	const now = new Date().toISOString();
	const next: ManagedSessionRecord = {
		...record,
		createdAt: record.createdAt || now,
		updatedAt: now,
	};
	await appendRegistryEvent(workspace, { type: "upsert", record: next, timestamp: now });
	return next;
}

export async function markManagedSession(
	workspace: WorkspacePaths,
	meshId: string,
	patch: Partial<ManagedSessionRecord>,
): Promise<ManagedSessionRecord | undefined> {
	const current = await findManagedSession(workspace, meshId);
	if (!current) return undefined;
	return upsertManagedSession(workspace, { ...current, ...patch });
}

export function socketPathFor(workspace: WorkspacePaths, meshId: string): string {
	return path.join(workspace.socketsDir, `${normalizeMeshId(meshId)}.sock`);
}

export function lockPathFor(workspace: WorkspacePaths, meshId: string): string {
	return path.join(workspace.locksDir, `${normalizeMeshId(meshId)}.lock`);
}
