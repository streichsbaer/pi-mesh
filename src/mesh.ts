import path from "node:path";
import type { MeshPaths } from "./types.js";
import { ensureDir, piAgentDir } from "./utils.js";

export async function resolveMesh(): Promise<MeshPaths> {
	const baseDir = path.join(piAgentDir(), "pi-mesh");
	const mesh: MeshPaths = {
		id: "local",
		baseDir,
		registryFile: path.join(baseDir, "registry.jsonl"),
		locksDir: path.join(baseDir, "locks"),
		socketDirFile: path.join(baseDir, "socket-dir"),
	};
	await ensureMesh(mesh);
	return mesh;
}

export async function ensureMesh(mesh: MeshPaths): Promise<void> {
	await Promise.all([
		ensureDir(mesh.baseDir),
		ensureDir(mesh.locksDir),
	]);
}
