#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "./utils.js";
import { formatTimestamp, truncate, compactWhitespace } from "./utils.js";
import { loadSessionData, loadSessionDataForSession, renderToolLine, resolveSessionSpec, searchSessions, tail } from "./pi-session-parser.js";
import { createMeshId, filterManagedSessions, findManagedSessions, listManagedSessions, lockPathFor, normalizeLabels, socketPathFor, upsertManagedSession, type SessionSelector } from "./registry.js";
import { resolveMesh } from "./mesh.js";
import { withDirectoryLock } from "./lock.js";
import { mergeModelSelection } from "./model-selection.js";
import { THINKING_LEVELS, type DeliveryMode, type ManagedSessionRecord, type MeshPaths, type ModelSelection, type SessionSummary, type ThinkingLevel } from "./types.js";

type OptionValue = string | boolean | Array<string | boolean>;

interface ParsedArgs {
	positionals: string[];
	options: Map<string, OptionValue>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const options = new Map<string, OptionValue>();
	const setOption = (name: string, value: string | boolean) => {
		const existing = options.get(name);
		if (existing === undefined) options.set(name, value);
		else if (Array.isArray(existing)) existing.push(value);
		else options.set(name, [existing, value]);
	};

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
			setOption(arg.slice(2, eq), arg.slice(eq + 1));
			continue;
		}

		const name = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			setOption(name, next);
			i += 1;
		} else {
			setOption(name, true);
		}
	}

	return { positionals, options };
}

function getString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
	const value = args.options.get(name);
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return [...value].reverse().find((item): item is string => typeof item === "string") ?? fallback;
	return fallback;
}

function getStrings(args: ParsedArgs, name: string): string[] {
	const value = args.options.get(name);
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return values.filter((item): item is string => typeof item === "string");
}

function getRequiredString(args: ParsedArgs, name: string): string | undefined {
	const value = args.options.get(name);
	if (value === true || (Array.isArray(value) && value.some((item) => item === true))) throw new Error(`--${name} requires a value.`);
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return [...value].reverse().find((item): item is string => typeof item === "string");
	return undefined;
}

function getBool(args: ParsedArgs, name: string): boolean {
	const value = args.options.get(name);
	return value === true || (Array.isArray(value) && value.includes(true));
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

function getThinkingLevel(args: ParsedArgs): ThinkingLevel | undefined {
	const value = getRequiredString(args, "thinking");
	if (value === undefined) return undefined;
	if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	throw new Error(`Invalid --thinking ${JSON.stringify(value)}. Expected: ${THINKING_LEVELS.join(", ")}.`);
}

function getModelSelection(args: ParsedArgs): ModelSelection | undefined {
	const provider = getRequiredString(args, "provider")?.trim();
	const model = getRequiredString(args, "model")?.trim();
	const thinkingLevel = getThinkingLevel(args);
	if (provider === "") throw new Error("--provider requires a non-empty value.");
	if (model === "") throw new Error("--model requires a non-empty value.");
	if (provider && !model) throw new Error("--provider requires --model.");
	if (!provider && !model && !thinkingLevel) return undefined;
	return { provider, model, thinkingLevel };
}

async function validateCliModelSelection(folder: string, modelSelection: ModelSelection | undefined): Promise<ModelSelection | undefined> {
	if (!modelSelection) return undefined;
	const { validateModelSelection } = await import("./pi-runner.js");
	return validateModelSelection({ cwd: folder, modelSelection });
}

async function resolveFolder(value: string | undefined): Promise<string> {
	const folder = path.resolve(value || process.cwd());
	return fs.realpath(folder).catch(() => folder);
}

function getLabels(args: ParsedArgs): string[] {
	for (const name of ["label", "labels"]) {
		const value = args.options.get(name);
		if (value === true || (Array.isArray(value) && value.some((item) => item === true))) throw new Error(`--${name} requires a value.`);
	}
	return normalizeLabels([...getStrings(args, "label"), ...getStrings(args, "labels")]);
}

async function getSessionSelector(args: ParsedArgs, spec?: string): Promise<SessionSelector> {
	const folderOption = getString(args, "folder");
	return {
		spec,
		folder: folderOption ? await resolveFolder(folderOption) : undefined,
		name: getString(args, "name"),
		labels: getLabels(args),
	};
}

function isLiveStatus(status: ManagedSessionRecord["status"]): boolean {
	return status === "running" || status === "idle" || status === "busy" || status === "starting";
}

function formatMatches(records: ManagedSessionRecord[]): string {
	return records.map((record) => `- ${record.meshId}${record.name ? ` name=${JSON.stringify(record.name)}` : ""} folder=${record.folder} status=${record.status}`).join("\n");
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
	mesh: MeshPaths,
	records: ManagedSessionRecord[],
): Promise<ManagedSessionRecord[]> {
	const refreshed: ManagedSessionRecord[] = [];
	for (const record of records) {
		const stale = isLiveStatus(record.status) && (!record.pid || !isProcessAlive(record.pid));
		if (!stale) {
			refreshed.push(record);
			continue;
		}
		if (record.socketPath) await fs.rm(record.socketPath, { force: true }).catch(() => undefined);
		refreshed.push(await upsertManagedSession(mesh, { ...record, status: "offline", socketPath: undefined, pid: undefined }));
	}
	return refreshed;
}

async function getMesh(): Promise<MeshPaths> {
	return resolveMesh();
}

function printHelp(): void {
	console.log(`pi-mesh

Usage:
  pi-mesh sessions list [--folder <dir>] [--name <name>] [--label <label>] [--limit 25] [--json] [--include-pi|--all]
  pi-mesh sessions find <query> [--folder <dir>] [--name <name>] [--label <label>] [--limit 25] [--json] [--include-pi|--all]
  pi-mesh transcript <session> [--folder <dir>] [--name <name>] [--label <label>] [--last 3] [--json] [--show-tools]
  pi-mesh state <session> [--folder <dir>] [--name <name>] [--label <label>] [--json]
  pi-mesh models list [search] [--folder <dir>] [--json] [--all] [--scoped]

  pi-mesh spawn --name <name> [--folder <dir>] [--label <label>] [--prompt <text>] [--attach] [--provider <name>] [--model <ref>] [--thinking <level>]
  pi-mesh run --name <name> [--folder <dir>] [--label <label>] [--new] [--prompt <text>] [--provider <name>] [--model <ref>] [--thinking <level>]
  pi-mesh attach <session|session-file> [--name <name>] [--folder <dir>] [--label <label>] [--provider <name>] [--model <ref>] [--thinking <level>]
  pi-mesh send [<session>] <message> [--folder <dir>] [--name <name>] [--label <label>] [--all] [--delivery auto|prompt|steer|follow-up] [--stream] [--provider <name>] [--model <ref>] [--thinking <level>]

Notes:
  - spawn defaults to sleeping/headless. Use --attach or pi-mesh run for vanilla Pi TUI.
  - send wakes sleeping managed sessions, or uses a live socket for pi-mesh run sessions.
  - sessions are tracked in one machine-local registry; --folder, --name, and --label filter it.
  - names and labels are not unique; use --all to intentionally broadcast to multiple matches.
  - pass --model provider/model or --model model:thinking to choose a session model.
  - use models list to inspect Pi-configured models; --folder selects the target session/settings scope, --all includes unauthenticated models, and --scoped filters Pi enabledModels.
  - unmanaged already-running Pi sessions are readable; close and attach them to make them managed.
`);
}

function printManaged(record: ManagedSessionRecord): void {
	const name = record.name ? `${record.name} ` : "";
	console.log(`${record.meshId} · ${name}${record.kind} · ${record.status}`);
	console.log(`  folder: ${record.folder}`);
	if (record.labels?.length) console.log(`  labels: ${record.labels.join(",")}`);
	console.log(`  sessionFile: ${record.sessionFile}`);
	if (record.socketPath) console.log(`  socket: ${record.socketPath}`);
	if (record.pendingModelSelection) {
		const model = record.pendingModelSelection.model
			? `${record.pendingModelSelection.provider ? `${record.pendingModelSelection.provider}/` : ""}${record.pendingModelSelection.model}`
			: undefined;
		console.log(`  pendingModel: ${[model, record.pendingModelSelection.thinkingLevel && `thinking=${record.pendingModelSelection.thinkingLevel}`].filter(Boolean).join(" ")}`);
	}
	console.log(`  updatedAt: ${record.updatedAt}`);
	if (record.lastError) console.log(`  error: ${record.lastError}`);
	console.log("");
}

async function cmdSessions(parsed: ParsedArgs): Promise<void> {
	const sub = parsed.positionals[1] || "list";
	const limit = getNumber(parsed, "limit", 25);
	const asJson = getBool(parsed, "json");
	const mesh = await getMesh();
	const selector = await getSessionSelector(parsed);
	const managed = filterManagedSessions(await refreshStaleManagedSessions(mesh, await listManagedSessions(mesh)), selector);

	if (sub === "list") {
		const includePi = getBool(parsed, "include-pi") || getBool(parsed, "all");
		const piSessions = includePi ? await searchSessions({ limit }) : [];
		if (asJson) {
			console.log(JSON.stringify({ ok: true, mesh, filters: selector, managed, piSessions }, null, 2));
			return;
		}
		console.log("# pi-mesh sessions");
		console.log("");
		console.log("## managed sessions");
		if (managed.length) for (const record of managed) printManaged(record);
		else console.log("[none]\n");
		if (includePi) {
			console.log("## recent Pi sessions");
			if (piSessions.length) {
				for (const item of piSessions) {
					console.log(`${item.rawSessionId} · ${item.sessionName || item.repoName}`);
					console.log(`  updatedAt: ${formatTimestamp(item.updatedAt)}`);
					console.log(`  path: ${item.path}`);
					console.log(`  lastUser: ${truncate(compactWhitespace(item.lastUser || item.firstUser || ""), 160)}`);
					console.log("");
				}
			} else {
				console.log("[none]\n");
			}
		}
		return;
	}

	if (sub === "find") {
		const query = parsed.positionals.slice(2).join(" ").trim();
		if (!query) throw new Error("Usage: pi-mesh sessions find <query>");
		const queryLower = query.toLowerCase();
		const managedMatches = managed.filter((record) =>
			[record.meshId, record.name, record.folder, record.sessionFile, record.rawSessionId, ...(record.labels ?? [])]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(queryLower)),
		);
		const exactManaged = managedMatches.some(
			(record) => record.meshId === query || record.name === query || record.rawSessionId === query || record.sessionFile === query,
		);
		const includePi = getBool(parsed, "include-pi") || getBool(parsed, "all");
		const piSessions = exactManaged && !includePi ? [] : await searchSessions({ query, limit });
		if (asJson) {
			console.log(JSON.stringify({ ok: true, mesh, filters: selector, managed: managedMatches, piSessions, skippedPiSearch: exactManaged && !includePi }, null, 2));
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
	mesh: MeshPaths,
	spec: string,
	selector: SessionSelector = {},
): Promise<{ sessionFile: string; folder: string; managed?: ManagedSessionRecord; summary?: SessionSummary }> {
	const matches = await findManagedSessions(mesh, { ...selector, spec });
	if (matches.length === 1) return { sessionFile: matches[0].sessionFile, folder: matches[0].folder, managed: matches[0] };
	if (matches.length > 1) throw new Error(`Multiple managed sessions match ${JSON.stringify(spec)}; refine with --folder, --name, or --label:\n${formatMatches(matches)}`);
	const session = await resolveSessionSpec(spec);
	return { sessionFile: session.path, folder: await resolveFolder(session.cwd || process.cwd()), summary: session };
}

async function cmdModels(parsed: ParsedArgs): Promise<void> {
	const sub = parsed.positionals[1] || "list";
	if (sub !== "list") throw new Error(`Unknown models subcommand: ${sub}`);
	const folder = await resolveFolder(getString(parsed, "folder") || process.cwd());
	const search = parsed.positionals.slice(2).join(" ").trim() || undefined;
	const { listModels, printModelList } = await import("./model-list.js");
	const result = await listModels({
		cwd: folder,
		search,
		includeAll: getBool(parsed, "all"),
		scopedOnly: getBool(parsed, "scoped"),
	});
	if (getBool(parsed, "json")) console.log(JSON.stringify(result, null, 2));
	else printModelList(result);
}

async function cmdTranscript(parsed: ParsedArgs): Promise<void> {
	const spec = parsed.positionals[1];
	if (!spec) throw new Error("Usage: pi-mesh transcript <session>");
	const mesh = await getMesh();
	const resolved = await resolveSessionFile(mesh, spec, await getSessionSelector(parsed));
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
	const mesh = await getMesh();
	const resolved = await resolveSessionFile(mesh, spec, await getSessionSelector(parsed));
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
			console.log(`folder: ${resolved.folder}`);
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
	console.log(`folder: ${data.session.cwd}`);
	if (resolved.managed) console.log(`managed: ${resolved.managed.meshId} · ${resolved.managed.kind} · ${resolved.managed.status}`);
	console.log(`turns: ${payload.counts.turns} · tools: ${payload.counts.tools} · failures: ${payload.counts.failures}`);
	if (payload.lastTurn) {
		console.log(`lastUser: ${truncate(compactWhitespace(payload.lastTurn.user || ""), 180)}`);
		console.log(`lastAssistant: ${truncate(compactWhitespace(payload.lastTurn.assistant || ""), 180)}`);
	}
}

async function registerSession(
	mesh: MeshPaths,
	input: {
		meshId?: string;
		name?: string;
		labels?: string[];
		folder: string;
		sessionFile: string;
		rawSessionId?: string;
		kind: ManagedSessionRecord["kind"];
		status: ManagedSessionRecord["status"];
		socketPath?: string;
		lastError?: string;
		pendingModelSelection?: ModelSelection;
	},
): Promise<ManagedSessionRecord> {
	const now = new Date().toISOString();
	const meshId = input.meshId || createMeshId({ folder: input.folder, sessionFile: input.sessionFile, rawSessionId: input.rawSessionId });
	return upsertManagedSession(mesh, {
		meshId,
		name: input.name,
		labels: normalizeLabels(input.labels ?? []),
		kind: input.kind,
		status: input.status,
		folder: input.folder,
		sessionFile: input.sessionFile,
		rawSessionId: input.rawSessionId,
		pid: process.pid,
		socketPath: input.socketPath,
		createdAt: now,
		updatedAt: now,
		lastError: input.lastError,
		pendingModelSelection: input.pendingModelSelection,
	});
}

async function upsertManagedStatus(
	mesh: MeshPaths,
	record: ManagedSessionRecord,
	patch: Partial<ManagedSessionRecord>,
): Promise<ManagedSessionRecord> {
	const pendingModelSelection = record.pendingModelSelection && (await exists(record.sessionFile)) ? undefined : record.pendingModelSelection;
	return upsertManagedSession(mesh, { ...record, pendingModelSelection, ...patch });
}

function assertNotAlreadyLive(record: ManagedSessionRecord | undefined, action: string): void {
	if (!record || !isLiveStatus(record.status) || !isProcessAlive(record.pid)) return;
	throw new Error(`Session ${record.meshId} is already live (${record.status}); use pi-mesh send or stop that TUI before ${action}.`);
}

async function cmdSpawn(parsed: ParsedArgs): Promise<void> {
	const folder = await resolveFolder(getString(parsed, "folder") || process.cwd());
	const name = getString(parsed, "name");
	const labels = getLabels(parsed);
	const prompt = getString(parsed, "prompt") || parsed.positionals.slice(1).join(" ").trim();
	const attach = getBool(parsed, "attach");
	const modelSelection = await validateCliModelSelection(folder, getModelSelection(parsed));
	const mesh = await getMesh();
	const { createPersistentSession, runHeadlessTurn, runInteractive } = await import("./pi-runner.js");
	const created = await createPersistentSession({ cwd: folder, name, modelSelection });
	if (!created.sessionFile) throw new Error("Pi did not create a persistent session file.");
	let record = await registerSession(mesh, {
		name,
		labels,
		folder,
		sessionFile: created.sessionFile,
		rawSessionId: created.rawSessionId,
		kind: attach ? "interactive" : "sleeping",
		status: attach ? "starting" : "offline",
		pendingModelSelection: modelSelection && !(await exists(created.sessionFile)) ? modelSelection : undefined,
	});

	if (attach) {
		const socketPath = await socketPathFor(mesh, record.meshId);
		record = await upsertManagedSession(mesh, { ...record, socketPath, status: "starting", kind: "interactive" });
		await runInteractive({
			cwd: folder,
			sessionFile: record.sessionFile,
			name,
			initialMessage: prompt || undefined,
			socketPath,
			modelSelection,
			onSessionFile: async (sessionFile, rawSessionId) => {
				if (!sessionFile) return;
				record = await upsertManagedSession(mesh, {
					...record,
					sessionFile,
					rawSessionId,
					status: "running",
					pid: process.pid,
					socketPath,
					pendingModelSelection: modelSelection && !(await exists(sessionFile)) ? modelSelection : undefined,
				});
			},
			onMaterialized: async () => {
				if (!record.pendingModelSelection) return;
				record = await upsertManagedStatus(mesh, record, {});
			},
			onStatus: async (status, error) => {
				record = await upsertManagedStatus(mesh, record, { status, lastError: error, pid: process.pid, socketPath });
			},
		});
		return;
	}

	if (prompt) {
		await upsertManagedSession(mesh, { ...record, status: "busy" });
		const result = await runHeadlessTurn({ cwd: folder, sessionFile: record.sessionFile, message: prompt, delivery: "prompt", stream: getBool(parsed, "stream"), modelSelection });
		record = await upsertManagedSession(mesh, {
			...record,
			sessionFile: result.sessionFile || record.sessionFile,
			rawSessionId: result.rawSessionId,
			status: "offline",
			pendingModelSelection: undefined,
		});
	}

	if (getBool(parsed, "json")) console.log(JSON.stringify({ ok: true, mesh, session: record }, null, 2));
	else {
		console.log(`Spawned sleeping session ${record.meshId}`);
		console.log(`sessionFile: ${record.sessionFile}`);
	}
}

async function cmdRun(parsed: ParsedArgs): Promise<void> {
	const folder = await resolveFolder(getString(parsed, "folder") || process.cwd());
	const name = getString(parsed, "name");
	const labels = getLabels(parsed);
	const prompt = getString(parsed, "prompt") || parsed.positionals.slice(1).join(" ").trim();
	const rawModelSelection = getModelSelection(parsed);
	const mesh = await getMesh();
	await refreshStaleManagedSessions(mesh, await listManagedSessions(mesh));

	let existing: ManagedSessionRecord | undefined;
	if (name && !getBool(parsed, "new")) {
		const matches = await findManagedSessions(mesh, { folder, name, labels });
		if (matches.length > 1) throw new Error(`Multiple sessions named ${JSON.stringify(name)} match this folder/label selection; use a session id or --new:\n${formatMatches(matches)}`);
		existing = matches[0];
	}
	assertNotAlreadyLive(existing, "opening another live TUI");

	const sessionFile = existing?.sessionFile;
	const pendingModelSelection = existing && !(await exists(existing.sessionFile)) ? existing.pendingModelSelection : undefined;
	const seedModelSelection = mergeModelSelection(pendingModelSelection, rawModelSelection);
	const runFolder = existing?.folder || folder;
	const modelSelection = await validateCliModelSelection(runFolder, seedModelSelection);
	const meshId = existing?.meshId || createMeshId({ folder: runFolder, sessionFile });
	const socketPath = await socketPathFor(mesh, meshId);
	let record = existing;

	const { runInteractive } = await import("./pi-runner.js");
	await runInteractive({
		cwd: runFolder,
		sessionFile,
		name,
		initialMessage: prompt || undefined,
		socketPath,
		modelSelection,
		onSessionFile: async (newSessionFile, rawSessionId) => {
			if (!newSessionFile) return;
			record = await registerSession(mesh, {
				meshId,
				name,
				labels: labels.length ? labels : existing?.labels,
				folder: runFolder,
				sessionFile: newSessionFile,
				rawSessionId,
				kind: "interactive",
				status: "running",
				socketPath,
				pendingModelSelection: modelSelection && !(await exists(newSessionFile)) ? modelSelection : undefined,
			});
		},
		onMaterialized: async () => {
			if (!record?.pendingModelSelection) return;
			record = await upsertManagedStatus(mesh, record, {});
		},
		onStatus: async (status, error) => {
			if (!record) return;
			record = await upsertManagedStatus(mesh, record, { status, lastError: error, pid: process.pid, socketPath });
		},
	});
}

async function cmdAttach(parsed: ParsedArgs): Promise<void> {
	const spec = parsed.positionals[1];
	if (!spec) throw new Error("Usage: pi-mesh attach <session|session-file>");
	const rawModelSelection = getModelSelection(parsed);
	const mesh = await getMesh();
	await refreshStaleManagedSessions(mesh, await listManagedSessions(mesh));
	const resolved = await resolveSessionFile(mesh, spec);
	assertNotAlreadyLive(resolved.managed, "attaching it again");
	const folder = getString(parsed, "folder") ? await resolveFolder(getString(parsed, "folder")) : resolved.folder;
	const pendingModelSelection = resolved.managed && !(await exists(resolved.managed.sessionFile)) ? resolved.managed.pendingModelSelection : undefined;
	const seedModelSelection = mergeModelSelection(pendingModelSelection, rawModelSelection);
	const modelSelection = await validateCliModelSelection(folder, seedModelSelection);
	const name = getString(parsed, "name", resolved.managed?.name);
	const labels = getLabels(parsed);
	const meshId = resolved.managed?.meshId || createMeshId({ folder, sessionFile: resolved.sessionFile });
	const socketPath = await socketPathFor(mesh, meshId);
	let record = resolved.managed;

	if (!resolved.managed) {
		console.error("Note: attaching an unmanaged Pi session. Close any other Pi process using the same JSONL file first.");
	}

	const { runInteractive } = await import("./pi-runner.js");
	await runInteractive({
		cwd: folder,
		sessionFile: resolved.sessionFile,
		name,
		socketPath,
		modelSelection,
		onSessionFile: async (sessionFile, rawSessionId) => {
			if (!sessionFile) return;
			record = await registerSession(mesh, {
				meshId,
				name,
				labels: labels.length ? labels : resolved.managed?.labels,
				folder,
				sessionFile,
				rawSessionId,
				kind: "attached",
				status: "running",
				socketPath,
				pendingModelSelection: modelSelection && !(await exists(sessionFile)) ? modelSelection : undefined,
			});
		},
		onMaterialized: async () => {
			if (!record?.pendingModelSelection) return;
			record = await upsertManagedStatus(mesh, record, {});
		},
		onStatus: async (status, error) => {
			if (!record) return;
			record = await upsertManagedStatus(mesh, record, { status, lastError: error, pid: process.pid, socketPath });
		},
	});
}

async function deliverToManagedSession(
	mesh: MeshPaths,
	managed: ManagedSessionRecord,
	message: string,
	delivery: DeliveryMode,
	rawModelSelection: ModelSelection | undefined,
	stream: boolean,
): Promise<{ delivery: "live" | "wake"; session: ManagedSessionRecord }> {
	const sessionFileExists = await exists(managed.sessionFile);
	const pendingModelSelection = !sessionFileExists ? managed.pendingModelSelection : undefined;
	const usingPendingModelSelection = Boolean(pendingModelSelection);
	const modelSelection = await validateCliModelSelection(managed.folder, mergeModelSelection(pendingModelSelection, rawModelSelection));
	const socket = managed.socketPath;
	if (socket && (await exists(socket))) {
		const { sendToLiveSocket } = await import("./pi-runner.js");
		try {
			await sendToLiveSocket(socket, message, delivery, modelSelection);
			if (usingPendingModelSelection) managed = await upsertManagedSession(mesh, { ...managed, pendingModelSelection: undefined });
			return { delivery: "live", session: managed };
		} catch (error) {
			if (!isStaleSocketError(error)) throw error;
			await fs.rm(socket, { force: true }).catch(() => undefined);
			managed = await upsertManagedSession(mesh, {
				...managed,
				status: "offline",
				socketPath: undefined,
				pid: undefined,
				lastError: undefined,
			});
		}
	}

	const lockPath = lockPathFor(mesh, managed.meshId);
	let response: { delivery: "live" | "wake"; session: ManagedSessionRecord } | undefined;
	await withDirectoryLock(lockPath, async () => {
		const { runHeadlessTurn } = await import("./pi-runner.js");
		await upsertManagedSession(mesh, { ...managed, status: "busy", lastError: undefined });
		try {
			const result = await runHeadlessTurn({
				cwd: managed.folder,
				sessionFile: managed.sessionFile,
				message,
				delivery: "prompt",
				stream,
				modelSelection,
			});
			const next = await upsertManagedSession(mesh, {
				...managed,
				sessionFile: result.sessionFile || managed.sessionFile,
				rawSessionId: result.rawSessionId,
				status: "offline",
				lastError: undefined,
				pendingModelSelection: undefined,
			});
			response = { delivery: "wake", session: next };
		} catch (error) {
			await upsertManagedSession(mesh, { ...managed, status: "error", lastError: (error as Error).message });
			throw error;
		}
	});
	return response!;
}

async function cmdSend(parsed: ParsedArgs): Promise<void> {
	const positional = parsed.positionals.slice(1);
	const hasSelectorOptions = Boolean(getString(parsed, "folder") || getString(parsed, "name") || getLabels(parsed).length);
	let spec: string | undefined;
	let message: string | undefined;
	const messageOption = getString(parsed, "message", "");
	if (positional.length >= 2) {
		spec = positional[0];
		message = positional.slice(1).join(" ").trim();
	} else if (positional.length === 1 && messageOption) {
		spec = positional[0];
		message = messageOption;
	} else {
		message = positional[0] || messageOption;
	}
	if (!message) throw new Error("Usage: pi-mesh send [<session>] <message>");
	if (!spec && !hasSelectorOptions) throw new Error("Usage: pi-mesh send [<session>] <message> [--folder <dir>] [--name <name>] [--label <label>]");

	const rawModelSelection = getModelSelection(parsed);
	const mesh = await getMesh();
	await refreshStaleManagedSessions(mesh, await listManagedSessions(mesh));
	const matches = await findManagedSessions(mesh, await getSessionSelector(parsed, spec));
	if (!matches.length) {
		if (spec) {
			const session = await resolveSessionSpec(spec).catch(() => null);
			if (session) {
				throw new Error(
					`Session is readable but not managed: ${session.path}\nClose the original Pi TUI, then run: pi-mesh attach ${JSON.stringify(session.path)}`,
				);
			}
		}
		throw new Error(`No managed session found for ${JSON.stringify(spec || "selector")}`);
	}
	if (matches.length > 1 && !getBool(parsed, "all")) {
		throw new Error(`Multiple managed sessions match; refine with --folder, --name, --label, use a session id, or pass --all:\n${formatMatches(matches)}`);
	}

	const results = [];
	for (const managed of matches) {
		results.push(await deliverToManagedSession(mesh, managed, message, getDelivery(parsed), rawModelSelection, getBool(parsed, "stream")));
	}

	if (getBool(parsed, "json")) {
		console.log(JSON.stringify({ ok: true, results, sessions: results.map((result) => result.session) }, null, 2));
		return;
	}
	for (const result of results) {
		if (result.delivery === "live") console.log(`Sent to live session ${result.session.meshId}`);
		else console.log(`Woke session ${result.session.meshId}, delivered message, and shut it down.`);
	}
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	const command = parsed.positionals[0];
	if (!command || command === "help" || getBool(parsed, "help")) {
		printHelp();
		return;
	}

	if (command === "sessions") return cmdSessions(parsed);
	if (command === "models") return cmdModels(parsed);
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
