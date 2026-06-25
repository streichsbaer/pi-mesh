import path from "node:path";
import type { WorkspacePaths } from "./types.js";
import { ensureDir, findGitRoot, piAgentDir, stableId } from "./utils.js";

export async function resolveWorkspace(cwd = process.cwd(), explicitRoot?: string): Promise<WorkspacePaths> {
	const root = path.resolve(explicitRoot || (await findGitRoot(cwd)) || cwd);
	const id = stableId(root);
	const baseDir = path.join(piAgentDir(), "pi-mesh", "workspaces", id);
	const workspace: WorkspacePaths = {
		id,
		root,
		baseDir,
		registryFile: path.join(baseDir, "registry.jsonl"),
		inboxDir: path.join(baseDir, "inbox"),
		locksDir: path.join(baseDir, "locks"),
		socketsDir: path.join(baseDir, "sockets"),
	};
	await ensureWorkspace(workspace);
	return workspace;
}

export async function ensureWorkspace(workspace: WorkspacePaths): Promise<void> {
	await Promise.all([
		ensureDir(workspace.baseDir),
		ensureDir(workspace.inboxDir),
		ensureDir(workspace.locksDir),
		ensureDir(workspace.socketsDir),
	]);
}
