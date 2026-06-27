import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const cliPath = path.join(repoRoot, "dist", "cli.js");
export const defaultE2EModel = "openai-codex/gpt-5.4-mini";

export interface E2EContext {
	root: string;
	home: string;
	agentDir: string;
	workspace: string;
	model: string;
	env: NodeJS.ProcessEnv;
}

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function requireRealE2E(kind: string): boolean {
	if (process.env.PI_MESH_REAL_E2E === "1") return true;
	console.log(`Skipping ${kind}; set PI_MESH_REAL_E2E=1 to run real Pi CLI E2E tests.`);
	return false;
}

export function ensureBuilt(): void {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
	assert(result.status === 0, `npm run build failed with ${result.status}`);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function copyIfExists(source: string, destination: string): Promise<boolean> {
	if (!(await exists(source))) return false;
	await mkdir(path.dirname(destination), { recursive: true });
	await copyFile(source, destination);
	return true;
}

export async function setupRealE2E(): Promise<E2EContext> {
	const tempBase = process.env.PI_MESH_E2E_TMPDIR || tmpdir();
	const root = await mkdtemp(path.join(tempBase, "pi-mesh-real-e2e-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const workspace = path.join(root, "workspace");
	await mkdir(agentDir, { recursive: true });
	await mkdir(workspace, { recursive: true });

	const sourceAgentDir = process.env.PI_MESH_E2E_SOURCE_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	const copiedAuth = await copyIfExists(path.join(sourceAgentDir, "auth.json"), path.join(agentDir, "auth.json"));
	assert(copiedAuth, `Missing auth.json at ${sourceAgentDir}; set PI_MESH_E2E_SOURCE_AGENT_DIR or run pi login first.`);
	await copyIfExists(path.join(sourceAgentDir, "models.json"), path.join(agentDir, "models.json"));
	if (process.env.PI_MESH_E2E_COPY_SETTINGS === "1") {
		await copyIfExists(path.join(sourceAgentDir, "settings.json"), path.join(agentDir, "settings.json"));
	}

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		TERM: process.env.TERM || "xterm-256color",
	};

	return {
		root,
		home,
		agentDir,
		workspace,
		model: process.env.PI_MESH_E2E_MODEL || defaultE2EModel,
		env,
	};
}

async function cleanupRuntimeSocketDirs(ctx: E2EContext): Promise<void> {
	const workspacesDir = path.join(ctx.agentDir, "pi-mesh", "workspaces");
	const entries = await readdir(workspacesDir, { withFileTypes: true }).catch(() => []);
	await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
		const socketDir = (await readFile(path.join(workspacesDir, entry.name, "socket-dir"), "utf8").catch(() => "")).trim();
		if (!socketDir) return;
		const socketRoot = path.dirname(socketDir);
		if (path.basename(socketRoot).startsWith("pi-mesh-")) await rm(socketRoot, { recursive: true, force: true });
	}));
}

export async function cleanupRealE2E(ctx: E2EContext): Promise<void> {
	if (process.env.PI_MESH_E2E_KEEP === "1") {
		console.log(`Keeping E2E temp root: ${ctx.root}`);
		return;
	}
	await cleanupRuntimeSocketDirs(ctx);
	await rm(ctx.root, { recursive: true, force: true });
}

export async function runCli(ctx: E2EContext, args: string[], options: { timeoutMs?: number; expectFailure?: boolean } = {}): Promise<CliResult> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd: repoRoot,
		env: ctx.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});

	const exitCode = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref();
			reject(new Error(`Timed out after ${timeoutMs}ms: pi-mesh ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code ?? 1);
		});
	});

	if (!options.expectFailure && exitCode !== 0) {
		throw new Error(`pi-mesh ${args.join(" ")} failed with ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { stdout, stderr, exitCode };
}

export function parseJson<T = any>(result: CliResult): T {
	try {
		return JSON.parse(result.stdout) as T;
	} catch (error) {
		throw new Error(`Failed to parse JSON output: ${(error as Error).message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000, intervalMs = 1000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await fn();
			if (value !== undefined) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? `; last error: ${(lastError as Error).message}` : ""}`);
}

export async function getManagedSession(ctx: E2EContext, name: string): Promise<any | undefined> {
	const payload = parseJson(await runCli(ctx, ["sessions", "list", "--workspace", ctx.workspace, "--json"], { timeoutMs: 30_000 }));
	return payload.managed?.find((record: any) => record.meshId === name || record.name === name);
}

export async function waitForManagedSession(ctx: E2EContext, name: string, predicate: (record: any) => boolean, timeoutMs = 60_000): Promise<any> {
	return waitFor(`managed session ${name}`, async () => {
		const record = await getManagedSession(ctx, name);
		return record && predicate(record) ? record : undefined;
	}, timeoutMs);
}

async function socketFileExists(socketPath: string): Promise<boolean> {
	return exists(socketPath);
}

export async function waitForLiveManagedSession(ctx: E2EContext, name: string, timeoutMs = 60_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now());
		const record = await waitFor(`live socket for ${name}`, async () => {
			const candidate = await getManagedSession(ctx, name);
			if (!candidate || candidate.status !== "running" || !candidate.socketPath) return undefined;
			return (await socketFileExists(candidate.socketPath)) ? candidate : undefined;
		}, remaining);
		await sleep(1000);
		if (await socketFileExists(record.socketPath)) return record;
	}
	throw new Error(`Timed out waiting for stable live socket for ${name}`);
}

export async function getTranscript(ctx: E2EContext, name: string, last = 5): Promise<any> {
	return parseJson(await runCli(ctx, ["transcript", name, "--workspace", ctx.workspace, "--last", String(last), "--json"], { timeoutMs: 30_000 }));
}

function assistantText(turn: any): string {
	return [turn.finalAssistant?.text, ...(turn.assistantMessages ?? []).map((message: any) => message.text)]
		.filter(Boolean)
		.join("\n");
}

export async function waitForAssistantTurn(ctx: E2EContext, name: string, userNeedle: string, assistantNeedle: string, timeoutMs = 60_000): Promise<any> {
	return waitFor(`assistant turn for ${name}`, async () => {
		const transcript = await getTranscript(ctx, name, 5);
		const turn = transcript.turns?.find((item: any) => item.user?.text?.includes(userNeedle) && assistantText(item).includes(assistantNeedle));
		return turn;
	}, timeoutMs, 1500);
}
