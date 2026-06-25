#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "./utils.js";
import { formatTimestamp, truncate, compactWhitespace } from "./utils.js";
import { loadSessionData, loadSessionDataForSession, renderToolLine, resolveSessionSpec, searchSessions, tail } from "./pi-session-parser.js";
import { createMeshId, findManagedSession, listManagedSessions, lockPathFor, socketPathFor, upsertManagedSession } from "./registry.js";
import { resolveWorkspace } from "./workspace.js";
import { withDirectoryLock } from "./lock.js";
import type { DeliveryMode, ManagedSessionRecord, SessionSummary, WorkspacePaths } from "./types.js";

interface ParsedArgs {
	positionals: string[];
	options: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const options = new Map<string, string | boolean>();

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}

		const eq = arg.indexOf("=");
		if (eq >= 0) {
			options.set(arg.slice(2, eq), arg.slice(eq + 1));
			continue;
		}

		const name = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			options.set(name, next);
			i += 1;
		} else {
			options.set(name, true);
		}
	}

	return { positionals, options };
}

function getString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
	const value = args.options.get(name);
	if (typeof value === "string") return value;
	return fallback;
}

function getBool(args: ParsedArgs, name: string): boolean {
	return args.options.get(name) === true;
}

function getNumber(args: ParsedArgs, name: string, fallback: number): number {
	const value = Number(getString(args, name, String(fallback)));
	return Number.isFinite(value) ? value : fallback;
}

function getDelivery(args: ParsedArgs): DeliveryMode {
	const value = getString(args, "delivery", "auto") as DeliveryMode;
	if (["auto", "prompt", "steer", "follow-up"].includes(value)) return value;
	throw new Error(`Invalid --delivery ${JSON.stringify(value)}. Expected auto, prompt, steer, or follow-up.`);
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isStaleSocketError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ECONNREFUSED" || code === "ENOENT" || code === "EPIPE" || code === "ECONNRESET";
}

async function refreshStaleManagedSessions(
	workspace: WorkspacePaths,
	records: ManagedSessionRecord[],
): Promise<ManagedSessionRecord[]> {
	const refreshed: ManagedSessionRecord[] = [];
	for (const record of records) {
		const possiblyLive = record.status === "running" || record.status === "idle" || record.status === "busy" || record.status === "starting";
		const stale = possiblyLive && (!record.pid || !isProcessAlive(record.pid));
		if (!stale) {
			refreshed.push(record);
			continue;
		}
		if (record.socketPath) await fs.rm(record.socketPath, { force: true }).catch(() => undefined);
		refreshed.push(await upsertManagedSession(workspace, { ...record, status: "offline", socketPath: undefined, pid: undefined }));
	}
	return refreshed;
}

async function getWorkspace(args: ParsedArgs, cwd = process.cwd()): Promise<WorkspacePaths> {
	return resolveWorkspace(cwd, getString(args, "workspace"));
}

function printHelp(): void {
	console.log(`pi-mesh

Usage:
  pi-mesh sessions list [--limit 25] [--json]
  pi-mesh sessions find <query> [--limit 25] [--json]
  pi-mesh transcript <session> [--last 3] [--json] [--show-tools]
  pi-mesh state <session> [--json]

  pi-mesh spawn --name <name> [--cwd <dir>] [--prompt <text>] [--attach]
  pi-mesh run --name <name> [--cwd <dir>] [--prompt <text>]
  pi-mesh attach <session|session-file> [--name <name>]
  pi-mesh send <session> <message> [--delivery auto|prompt|steer|follow-up] [--stream]

Notes:
  - spawn defaults to sleeping/headless. Use --attach or pi-mesh run for vanilla Pi TUI.
  - send wakes sleeping managed sessions, or uses a live socket for pi-mesh run sessions.
  - unmanaged already-running Pi sessions are readable; close and attach them to make them managed.
`);
}

function printManaged(record: ManagedSessionRecord): void {
	const name = record.name ? `${record.name} ` : "";
	console.log(`${record.meshId} · ${name}${record.kind} · ${record.status}`);
	console.log(`  cwd: ${record.cwd}`);
	console.log(`  sessionFile: ${record.sessionFile}`);
	if (record.socketPath) console.log(`  socket: ${record.socketPath}`);
	console.log(`  updatedAt: ${record.updatedAt}`);
	if (record.lastError) console.log(`  error: ${record.lastError}`);
	console.log("");
}

async function cmdSessions(parsed: ParsedArgs): Promise<void> {
	const sub = parsed.positionals[1] || "list";
	const limit = getNumber(parsed, "limit", 25);
	const asJson = getBool(parsed, "json");
	const workspace = await getWorkspace(parsed);
	const managed = await refreshStaleManagedSessions(workspace, await listManagedSessions(workspace));

	if (sub === "list") {
		const piSessions = await searchSessions({ limit });
		if (asJson) {
			console.log(JSON.stringify({ ok: true, workspace, managed, piSessions }, null, 2));
			return;
		}
		console.log(`# workspace ${workspace.root}`);
		console.log("");
		console.log("## managed sessions");
		if (managed.length) for (const record of managed) printManaged(record);
		else console.log("[none]\n");
		console.log("## recent Pi sessions");
		for (const item of piSessions) {
			console.log(`${item.rawSessionId} · ${item.sessionName || item.repoName}`);
			console.log(`  updatedAt: ${formatTimestamp(item.updatedAt)}`);
			console.log(`  path: ${item.path}`);
			console.log(`  lastUser: ${truncate(compactWhitespace(item.lastUser || item.firstUser || ""), 160)}`);
			console.log("");
		}
		return;
	}

	if (sub === "find") {
		const query = parsed.positionals.slice(2).join(" ").trim();
		if (!query) throw new Error("Usage: pi-mesh sessions find <query>");
		const queryLower = query.toLowerCase();
		const managedMatches = managed.filter((record) =>
			[record.meshId, record.name, record.cwd, record.sessionFile, record.rawSessionId]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(queryLower)),
		);
		const exactManaged = managedMatches.some(
			(record) => record.meshId === query || record.name === query || record.rawSessionId === query || record.sessionFile === query,
		);
		const includePi = getBool(parsed, "include-pi") || getBool(parsed, "all");
		const piSessions = exactManaged && !includePi ? [] : await searchSessions({ query, limit });
		if (asJson) {
			console.log(JSON.stringify({ ok: true, workspace, managed: managedMatches, piSessions, skippedPiSearch: exactManaged && !includePi }, null, 2));
			return;
		}
		console.log("## managed matches");
		if (managedMatches.length) for (const record of managedMatches) printManaged(record);
		else console.log("[none]\n");
		if (exactManaged && !includePi) {
			console.log("## Pi session matches");
			console.log("[skipped exact managed match; pass --include-pi to search unmanaged Pi sessions]\n");
			return;
		}
		console.log("## Pi session matches");
		for (const item of piSessions) {
			console.log(`${item.rawSessionId} · ${item.sessionName || item.repoName}`);
			console.log(`  path: ${item.path}`);
			console.log(`  lastUser: ${truncate(compactWhitespace(item.lastUser || item.firstUser || ""), 160)}`);
			console.log("");
		}
		return;
	}

	throw new Error(`Unknown sessions subcommand: ${sub}`);
}

async function resolveSessionFile(
	workspace: WorkspacePaths,
	spec: string,
): Promise<{ sessionFile: string; cwd: string; managed?: ManagedSessionRecord; summary?: SessionSummary }> {
	const managed = await findManagedSession(workspace, spec);
	if (managed) return { sessionFile: managed.sessionFile, cwd: managed.cwd, managed };
	const session = await resolveSessionSpec(spec);
	return { sessionFile: session.path, cwd: session.cwd || process.cwd(), summary: session };
}

async function cmdTranscript(parsed: ParsedArgs): Promise<void> {
	const spec = parsed.positionals[1];
	if (!spec) throw new Error("Usage: pi-mesh transcript <session>");
	const workspace = await getWorkspace(parsed);
	const resolved = await resolveSessionFile(workspace, spec);
	if (!(await exists(resolved.sessionFile))) {
		const payload = { ok: true, managed: resolved.managed, sessionFile: resolved.sessionFile, transcriptAvailable: false, turns: [] };
		if (getBool(parsed, "json")) console.log(JSON.stringify(payload, null, 2));
		else {
			console.log(`# ${resolved.sessionFile}`);
			console.log("[transcript not available yet]");
			if (resolved.managed) console.log(`managed: ${resolved.managed.meshId} · ${resolved.managed.kind} · ${resolved.managed.status}`);
		}
		return;
	}
	const data = resolved.summary ? await loadSessionDataForSession(resolved.summary) : await loadSessionData(resolved.sessionFile);
	const last = Math.max(1, getNumber(parsed, "last", 3));
	const asJson = getBool(parsed, "json");
	const showTools = getBool(parsed, "show-tools");
	const turns = tail(data.turns, last);

	if (asJson) {
		console.log(JSON.stringify({ ok: true, managed: resolved.managed, session: data.session, turns }, null, 2));
		return;
	}

	console.log(`# ${data.session.path}`);
	console.log(`rawSessionId: ${data.session.rawSessionId}`);
	console.log("");
	for (const turn of turns) {
		console.log(`## Turn ${turn.index} · ${formatTimestamp(turn.startedAt)}`);
		console.log(`user: ${truncate(compactWhitespace(turn.user.text || ""), 260)}`);
		console.log(`assistantMessages: ${turn.assistantMessages.length} · toolCalls: ${turn.toolInvocations.length} · failures: ${turn.failures.length}`);
		console.log("");
		if (showTools) {
			for (const tool of turn.toolInvocations) {
				console.log(renderToolLine(tool));
				console.log("");
			}
		} else {
			console.log(turn.finalAssistant?.text || "[no assistant text]");
			console.log("");
		}
	}
}

async function cmdState(parsed: ParsedArgs): Promise<void> {
	const spec = parsed.positionals[1];
	if (!spec) throw new Error("Usage: pi-mesh state <session>");
	const workspace = await getWorkspace(parsed);
	const resolved = await resolveSessionFile(workspace, spec);
	if (!(await exists(resolved.sessionFile))) {
		const payload = {
			ok: true,
			managed: resolved.managed,
			sessionFile: resolved.sessionFile,
			transcriptAvailable: false,
			counts: { entries: 0, events: 0, turns: 0, tools: 0, failures: 0 },
			lastTurn: null,
		};
		if (getBool(parsed, "json")) console.log(JSON.stringify(payload, null, 2));
		else {
			console.log(`${resolved.managed?.rawSessionId || resolved.managed?.meshId || spec} · ${resolved.managed?.name || "managed session"}`);
			console.log(`path: ${resolved.sessionFile}`);
			console.log(`cwd: ${resolved.cwd}`);
			if (resolved.managed) console.log(`managed: ${resolved.managed.meshId} · ${resolved.managed.kind} · ${resolved.managed.status}`);
			console.log("transcript: not available yet");
		}
		return;
	}
	const data = resolved.summary ? await loadSessionDataForSession(resolved.summary) : await loadSessionData(resolved.sessionFile);
	const lastTurn = data.turns[data.turns.length - 1];
	const payload = {
		ok: true,
		managed: resolved.managed,
		session: data.session,
		counts: {
			entries: data.transcript.entries.length,
			events: data.events.length,
			turns: data.turns.length,
			tools: data.toolInvocations.length,
			failures: data.toolInvocations.filter((tool) => tool.failed).length,
		},
		lastTurn: lastTurn
			? {
				index: lastTurn.index,
				startedAt: lastTurn.startedAt,
				user: lastTurn.user.text,
				assistant: lastTurn.finalAssistant?.text || null,
			}
			: null,
	};

	if (getBool(parsed, "json")) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`${data.session.rawSessionId} · ${data.session.sessionName || data.session.repoName}`);
	console.log(`path: ${data.session.path}`);
	console.log(`cwd: ${data.session.cwd}`);
	if (resolved.managed) console.log(`managed: ${resolved.managed.meshId} · ${resolved.managed.kind} · ${resolved.managed.status}`);
	console.log(`turns: ${payload.counts.turns} · tools: ${payload.counts.tools} · failures: ${payload.counts.failures}`);
	if (payload.lastTurn) {
		console.log(`lastUser: ${truncate(compactWhitespace(payload.lastTurn.user || ""), 180)}`);
		console.log(`lastAssistant: ${truncate(compactWhitespace(payload.lastTurn.assistant || ""), 180)}`);
	}
}

async function registerSession(
	workspace: WorkspacePaths,
	input: {
		name?: string;
		cwd: string;
		sessionFile: string;
		rawSessionId?: string;
		kind: ManagedSessionRecord["kind"];
		status: ManagedSessionRecord["status"];
		socketPath?: string;
		lastError?: string;
	},
): Promise<ManagedSessionRecord> {
	const now = new Date().toISOString();
	const meshId = createMeshId({ name: input.name, cwd: input.cwd, sessionFile: input.sessionFile });
	return upsertManagedSession(workspace, {
		meshId,
		name: input.name,
		kind: input.kind,
		status: input.status,
		cwd: input.cwd,
		sessionFile: input.sessionFile,
		rawSessionId: input.rawSessionId,
		pid: process.pid,
		socketPath: input.socketPath,
		createdAt: now,
		updatedAt: now,
		lastError: input.lastError,
	});
}

async function cmdSpawn(parsed: ParsedArgs): Promise<void> {
	const cwd = path.resolve(getString(parsed, "cwd", process.cwd()) || process.cwd());
	const name = getString(parsed, "name");
	const prompt = getString(parsed, "prompt") || parsed.positionals.slice(1).join(" ").trim();
	const attach = getBool(parsed, "attach");
	const workspace = await getWorkspace(parsed, cwd);
	const meshId = createMeshId({ name, cwd });
	const lockPath = lockPathFor(workspace, meshId);

	await withDirectoryLock(lockPath, async () => {
		const { createPersistentSession, runHeadlessTurn, runInteractive } = await import("./pi-runner.js");
		const created = await createPersistentSession({ cwd, name });
		if (!created.sessionFile) throw new Error("Pi did not create a persistent session file.");
		let record = await registerSession(workspace, {
			name,
			cwd,
			sessionFile: created.sessionFile,
			rawSessionId: created.rawSessionId,
			kind: attach ? "interactive" : "sleeping",
			status: attach ? "starting" : "offline",
		});

		if (attach) {
			const socketPath = socketPathFor(workspace, record.meshId);
			record = await upsertManagedSession(workspace, { ...record, socketPath, status: "starting", kind: "interactive" });
			await runInteractive({
				cwd,
				sessionFile: record.sessionFile,
				name,
				initialMessage: prompt || undefined,
				socketPath,
				onSessionFile: async (sessionFile, rawSessionId) => {
					if (!sessionFile) return;
					record = await upsertManagedSession(workspace, { ...record, sessionFile, rawSessionId, status: "running", pid: process.pid, socketPath });
				},
				onStatus: async (status, error) => {
					record = await upsertManagedSession(workspace, { ...record, status, lastError: error, pid: process.pid, socketPath });
				},
			});
			return;
		}

		if (prompt) {
			await upsertManagedSession(workspace, { ...record, status: "busy" });
			const result = await runHeadlessTurn({ cwd, sessionFile: record.sessionFile, message: prompt, delivery: "prompt", stream: getBool(parsed, "stream") });
			record = await upsertManagedSession(workspace, {
				...record,
				sessionFile: result.sessionFile || record.sessionFile,
				rawSessionId: result.rawSessionId,
				status: "offline",
			});
		}

		if (getBool(parsed, "json")) console.log(JSON.stringify({ ok: true, workspace, session: record }, null, 2));
		else {
			console.log(`Spawned sleeping session ${record.meshId}`);
			console.log(`sessionFile: ${record.sessionFile}`);
		}
	});
}

async function cmdRun(parsed: ParsedArgs): Promise<void> {
	const cwd = path.resolve(getString(parsed, "cwd", process.cwd()) || process.cwd());
	const name = getString(parsed, "name");
	const prompt = getString(parsed, "prompt") || parsed.positionals.slice(1).join(" ").trim();
	const workspace = await getWorkspace(parsed, cwd);
	const existing = name ? await findManagedSession(workspace, name) : undefined;
	const sessionFile = existing?.sessionFile;
	const meshId = createMeshId({ name, cwd, sessionFile });
	const socketPath = socketPathFor(workspace, existing?.meshId || meshId);
	let record = existing;

	const { runInteractive } = await import("./pi-runner.js");
	await runInteractive({
		cwd: existing?.cwd || cwd,
		sessionFile,
		name,
		initialMessage: prompt || undefined,
		socketPath,
		onSessionFile: async (newSessionFile, rawSessionId) => {
			if (!newSessionFile) return;
			record = await registerSession(workspace, {
				name,
				cwd: existing?.cwd || cwd,
				sessionFile: newSessionFile,
				rawSessionId,
				kind: "interactive",
				status: "running",
				socketPath,
			});
		},
		onStatus: async (status, error) => {
			if (!record) return;
			record = await upsertManagedSession(workspace, { ...record, status, lastError: error, pid: process.pid, socketPath });
		},
	});
}

async function cmdAttach(parsed: ParsedArgs): Promise<void> {
	const spec = parsed.positionals[1];
	if (!spec) throw new Error("Usage: pi-mesh attach <session|session-file>");
	const workspace = await getWorkspace(parsed);
	const resolved = await resolveSessionFile(workspace, spec);
	const name = getString(parsed, "name", resolved.managed?.name);
	const meshId = createMeshId({ name, cwd: resolved.cwd, sessionFile: resolved.sessionFile });
	const socketPath = socketPathFor(workspace, resolved.managed?.meshId || meshId);
	let record = resolved.managed;

	if (!resolved.managed) {
		console.error("Note: attaching an unmanaged Pi session. Close any other Pi process using the same JSONL file first.");
	}

	const { runInteractive } = await import("./pi-runner.js");
	await runInteractive({
		cwd: resolved.cwd,
		sessionFile: resolved.sessionFile,
		name,
		socketPath,
		onSessionFile: async (sessionFile, rawSessionId) => {
			if (!sessionFile) return;
			record = await registerSession(workspace, {
				name,
				cwd: resolved.cwd,
				sessionFile,
				rawSessionId,
				kind: "attached",
				status: "running",
				socketPath,
			});
		},
		onStatus: async (status, error) => {
			if (!record) return;
			record = await upsertManagedSession(workspace, { ...record, status, lastError: error, pid: process.pid, socketPath });
		},
	});
}

async function cmdSend(parsed: ParsedArgs): Promise<void> {
	const spec = parsed.positionals[1];
	const message = parsed.positionals.slice(2).join(" ").trim() || getString(parsed, "message", "");
	if (!spec || !message) throw new Error("Usage: pi-mesh send <session> <message>");
	const workspace = await getWorkspace(parsed);
	let managed = await findManagedSession(workspace, spec);
	if (!managed) {
		const session = await resolveSessionSpec(spec).catch(() => null);
		if (session) {
			throw new Error(
				`Session is readable but not managed: ${session.path}\nClose the original Pi TUI, then run: pi-mesh attach ${JSON.stringify(session.path)}`,
			);
		}
		throw new Error(`No managed session found for ${JSON.stringify(spec)}`);
	}

	const delivery = getDelivery(parsed);
	const socket = managed.socketPath;
	if (socket && (await exists(socket))) {
		const { sendToLiveSocket } = await import("./pi-runner.js");
		try {
			await sendToLiveSocket(socket, message, delivery);
			if (!getBool(parsed, "json")) console.log(`Sent to live session ${managed.meshId}`);
			else console.log(JSON.stringify({ ok: true, delivery: "live", session: managed }, null, 2));
			return;
		} catch (error) {
			if (!isStaleSocketError(error)) throw error;
			await fs.rm(socket, { force: true }).catch(() => undefined);
			managed = await upsertManagedSession(workspace, {
				...managed,
				status: "offline",
				socketPath: undefined,
				pid: undefined,
				lastError: undefined,
			});
			if (!getBool(parsed, "json")) console.error(`Stale live socket for ${managed.meshId}; waking session headlessly.`);
		}
	}

	const lockPath = lockPathFor(workspace, managed.meshId);
	await withDirectoryLock(lockPath, async () => {
		const { runHeadlessTurn } = await import("./pi-runner.js");
		await upsertManagedSession(workspace, { ...managed, status: "busy", lastError: undefined });
		try {
			const result = await runHeadlessTurn({
				cwd: managed.cwd,
				sessionFile: managed.sessionFile,
				message,
				delivery: "prompt",
				stream: getBool(parsed, "stream"),
			});
			const next = await upsertManagedSession(workspace, {
				...managed,
				sessionFile: result.sessionFile || managed.sessionFile,
				rawSessionId: result.rawSessionId,
				status: "offline",
				lastError: undefined,
			});
			if (!getBool(parsed, "json")) console.log(`Woke session ${managed.meshId}, delivered message, and shut it down.`);
			else console.log(JSON.stringify({ ok: true, delivery: "wake", session: next }, null, 2));
		} catch (error) {
			await upsertManagedSession(workspace, { ...managed, status: "error", lastError: (error as Error).message });
			throw error;
		}
	});
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	const command = parsed.positionals[0];
	if (!command || command === "help" || getBool(parsed, "help")) {
		printHelp();
		return;
	}

	if (command === "sessions") return cmdSessions(parsed);
	if (command === "transcript") return cmdTranscript(parsed);
	if (command === "state") return cmdState(parsed);
	if (command === "spawn") return cmdSpawn(parsed);
	if (command === "run") return cmdRun(parsed);
	if (command === "attach") return cmdAttach(parsed);
	if (command === "send") return cmdSend(parsed);

	throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
	if ((error as Error & { matches?: unknown }).matches) {
		console.error((error as Error).message);
		console.error(JSON.stringify({ matches: (error as Error & { matches?: unknown }).matches }, null, 2));
		process.exit(2);
	}
	console.error((error as Error).message || String(error));
	process.exit(1);
});
