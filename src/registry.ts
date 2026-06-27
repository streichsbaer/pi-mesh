import { promises as fs } from "node:fs";
import path from "node:path";
import type { ManagedSessionRecord, MeshPaths } from "./types.js";
import { compactWhitespace, ensureDir, ensurePrivateDir, safeJson, socketRuntimePrefix, stableId } from "./utils.js";

interface RegistryEvent {
	type: "upsert" | "delete";
	record?: ManagedSessionRecord;
	meshId?: string;
	timestamp: string;
}

export interface SessionSelector {
	spec?: string;
	folder?: string;
	name?: string;
	labels?: string[];
}

export function normalizeMeshId(nameOrId: string): string {
	return compactWhitespace(nameOrId)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export function normalizeLabel(label: string): string {
	return normalizeMeshId(label);
}

export function normalizeLabels(labels: Array<string | undefined>): string[] {
	return [...new Set(labels.flatMap((label) => String(label || "").split(",")).map(normalizeLabel).filter(Boolean))].sort();
}

export function createMeshId(input: { folder: string; sessionFile?: string; rawSessionId?: string }): string {
	const stableSource = input.rawSessionId || input.sessionFile;
	if (stableSource) return `session-${stableId(stableSource, 12)}`;
	return `session-${stableId(`${input.folder}:${Date.now()}:${Math.random()}`, 12)}`;
}

async function appendRegistryEvent(mesh: MeshPaths, event: RegistryEvent): Promise<void> {
	await fs.mkdir(path.dirname(mesh.registryFile), { recursive: true });
	await fs.appendFile(mesh.registryFile, `${JSON.stringify(event)}\n`, "utf8");
}

function coerceRecord(record: ManagedSessionRecord & { cwd?: string }): ManagedSessionRecord {
	const folder = record.folder || record.cwd || process.cwd();
	const labels = normalizeLabels(record.labels ?? []);
	const next: ManagedSessionRecord = { ...record, folder, labels };
	delete (next as ManagedSessionRecord & { cwd?: string }).cwd;
	return next;
}

export async function listManagedSessions(mesh: MeshPaths): Promise<ManagedSessionRecord[]> {
	const text = await fs.readFile(mesh.registryFile, "utf8").catch(() => "");
	const byId = new Map<string, ManagedSessionRecord>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const event = safeJson<RegistryEvent | null>(line, null);
		if (!event) continue;
		if (event.type === "delete" && event.meshId) byId.delete(event.meshId);
		if (event.type === "upsert" && event.record?.meshId) byId.set(event.record.meshId, coerceRecord(event.record));
	}
	return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function recordMatchesSpec(record: ManagedSessionRecord, spec: string): boolean {
	const normalized = normalizeMeshId(spec);
	return record.meshId === spec ||
		record.meshId === normalized ||
		record.name === spec ||
		(record.name ? normalizeMeshId(record.name) === normalized : false) ||
		record.sessionFile === spec ||
		record.rawSessionId === spec;
}

export function sessionMatchesSelector(record: ManagedSessionRecord, selector: SessionSelector): boolean {
	if (selector.spec && !recordMatchesSpec(record, selector.spec)) return false;
	if (selector.folder && record.folder !== selector.folder) return false;
	if (selector.name && record.name !== selector.name && normalizeMeshId(record.name || "") !== normalizeMeshId(selector.name)) return false;
	const labels = normalizeLabels(selector.labels ?? []);
	if (labels.length) {
		const existing = new Set(normalizeLabels(record.labels ?? []));
		if (!labels.every((label) => existing.has(label))) return false;
	}
	return true;
}

export function filterManagedSessions(records: ManagedSessionRecord[], selector: SessionSelector): ManagedSessionRecord[] {
	return records.filter((record) => sessionMatchesSelector(record, selector));
}

export async function findManagedSessions(mesh: MeshPaths, selector: SessionSelector): Promise<ManagedSessionRecord[]> {
	return filterManagedSessions(await listManagedSessions(mesh), selector);
}

export async function findManagedSession(mesh: MeshPaths, spec: string): Promise<ManagedSessionRecord | undefined> {
	return (await findManagedSessions(mesh, { spec }))[0];
}

function sameUnderlyingSession(a: ManagedSessionRecord, b: ManagedSessionRecord): boolean {
	return Boolean(
		(a.sessionFile && b.sessionFile && a.sessionFile === b.sessionFile) ||
		(a.rawSessionId && b.rawSessionId && a.rawSessionId === b.rawSessionId),
	);
}

export async function upsertManagedSession(
	mesh: MeshPaths,
	record: ManagedSessionRecord,
): Promise<ManagedSessionRecord> {
	const now = new Date().toISOString();
	const normalized = coerceRecord(record);
	const existing = (await listManagedSessions(mesh)).find((item) => item.meshId === normalized.meshId || sameUnderlyingSession(item, normalized));
	const next: ManagedSessionRecord = {
		...normalized,
		meshId: existing?.meshId || normalized.meshId,
		createdAt: existing?.createdAt || normalized.createdAt || now,
		updatedAt: now,
	};
	await appendRegistryEvent(mesh, { type: "upsert", record: next, timestamp: now });
	return next;
}

export async function markManagedSession(
	mesh: MeshPaths,
	meshId: string,
	patch: Partial<ManagedSessionRecord>,
): Promise<ManagedSessionRecord | undefined> {
	const current = await findManagedSession(mesh, meshId);
	if (!current) return undefined;
	return upsertManagedSession(mesh, { ...current, ...patch });
}

async function createRuntimeSocketDir(mesh: MeshPaths): Promise<string> {
	await ensureDir(mesh.baseDir);
	const root = await fs.mkdtemp(socketRuntimePrefix());
	await ensurePrivateDir(root);
	await fs.writeFile(mesh.socketDirFile, `${root}\n`, { mode: 0o600 });
	return root;
}

async function ensureStoredRuntimeSocketDir(dir: string): Promise<string | undefined> {
	try {
		await ensurePrivateDir(dir);
		return dir;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function runtimeSocketDirFor(mesh: MeshPaths): Promise<string> {
	const stored = (await fs.readFile(mesh.socketDirFile, "utf8").catch(() => "")).trim();
	if (stored) {
		const dir = await ensureStoredRuntimeSocketDir(stored);
		if (dir) return dir;
	}
	return createRuntimeSocketDir(mesh);
}

export async function socketPathFor(mesh: MeshPaths, meshId: string): Promise<string> {
	const dir = await runtimeSocketDirFor(mesh);
	return path.join(dir, `${stableId(meshId, 20)}.sock`);
}

export function lockPathFor(mesh: MeshPaths, meshId: string): string {
	return path.join(mesh.locksDir, `${normalizeMeshId(meshId)}.lock`);
}
