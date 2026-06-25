import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	AgentMessageLike,
	ContentPartLike,
	SessionData,
	SessionSummary,
	ToolInvocation,
	TranscriptEntry,
	TranscriptEvent,
	Turn,
} from "./types.js";
import {
	compactWhitespace,
	exists,
	formatTimestamp,
	piAgentDir,
	readJson,
	safeJson,
	truncate,
	walkFiles,
} from "./utils.js";

const DEFAULT_SESSION_ROOT = path.join(piAgentDir(), "sessions");
const LEGACY_INTERFACE_ROOT = path.join(piAgentDir(), "pi-agent-interface");

interface RegistryHint {
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	workflowId?: string;
	providerId?: string;
	laneId?: string;
	[key: string]: unknown;
}

interface RegistryHints {
	bySessionId: Map<string, RegistryHint & { _recordPath: string }>;
	bySessionFile: Map<string, RegistryHint & { _recordPath: string }>;
}

export interface SessionSearchOptions {
	query?: string;
	limit?: number;
	sessionRoot?: string;
	registryRoots?: string[];
}

export interface TimeWindow {
	since?: number | null;
	until?: number | null;
}

function defaultRegistryRoots(): string[] {
	return [
		path.join(LEGACY_INTERFACE_ROOT, "registry", "main-sessions"),
		path.join(LEGACY_INTERFACE_ROOT, "registry", "subagents"),
		path.join(LEGACY_INTERFACE_ROOT, "sessions"),
	];
}

export function contentText(part: ContentPartLike, options: { includeThinking?: boolean } = {}): string {
	if (!part || typeof part !== "object") return "";
	if (part.type === "text") {
		const text = (part as { text?: unknown }).text;
		return typeof text === "string" ? text : "";
	}
	if (part.type === "thinking") {
		const thinking = (part as { thinking?: unknown }).thinking;
		return options.includeThinking && typeof thinking === "string" ? thinking : "";
	}
	return "";
}

export function messageText(message: AgentMessageLike | undefined, options: { includeThinking?: boolean } = {}): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => contentText(part, options))
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function messageToolCalls(message: AgentMessageLike | undefined): Array<Extract<ContentPartLike, { type: "toolCall" }>> {
	if (!Array.isArray(message?.content)) return [];
	return message.content.filter((part): part is Extract<ContentPartLike, { type: "toolCall" }> => part?.type === "toolCall");
}

function contentStat(message: AgentMessageLike | undefined, type: string): number {
	if (!Array.isArray(message?.content)) return 0;
	return message.content.filter((part) => part?.type === type).length;
}

async function loadRegistryHints(registryRoots = defaultRegistryRoots()): Promise<RegistryHints> {
	const bySessionId = new Map<string, RegistryHint & { _recordPath: string }>();
	const bySessionFile = new Map<string, RegistryHint & { _recordPath: string }>();

	for (const root of registryRoots) {
		const files = await walkFiles(root, (file) => file.endsWith(".json"));
		for (const file of files) {
			const item = await readJson<RegistryHint | null>(file, null);
			if (!item?.sessionId) continue;
			const hint = { ...item, _recordPath: file };
			bySessionId.set(item.sessionId, hint);
			if (item.sessionFile) bySessionFile.set(item.sessionFile, hint);
		}
	}

	return { bySessionId, bySessionFile };
}

export async function parseSessionSummary(filePath: string, hints?: RegistryHints): Promise<SessionSummary | null> {
	const stat = await fs.stat(filePath).catch(() => null);
	if (!stat?.isFile()) return null;

	const text = await fs.readFile(filePath, "utf8").catch(() => "");
	if (!text) return null;

	const lines = text.split("\n").filter(Boolean);
	let header: TranscriptEntry | null = null;
	let firstUser = "";
	let lastUser = "";
	let lastAssistant = "";

	for (const line of lines) {
		const item = safeJson<TranscriptEntry | null>(line, null);
		if (!item) continue;
		if (!header && item.type === "session") header = item;

		if (item.type === "message" && item.message?.role === "user") {
			const value = compactWhitespace(messageText(item.message));
			if (!firstUser && value) firstUser = value;
			if (value) lastUser = value;
		}

		if (item.type === "message" && item.message?.role === "assistant") {
			const value = compactWhitespace(messageText(item.message));
			if (value) lastAssistant = value;
		}
	}

	if (!header?.id) return null;
	const hint = hints?.bySessionFile.get(filePath) || null;
	const cwd = typeof header.cwd === "string" ? header.cwd : "";

	return {
		path: filePath,
		rawSessionId: header.id,
		cwd,
		repoName: path.basename(cwd || path.dirname(filePath)),
		timestamp: typeof header.timestamp === "string" ? header.timestamp : null,
		updatedAt: stat.mtimeMs,
		sessionName: hint?.sessionName || "",
		dashboardSessionId: hint?.sessionId || "",
		workflowId: hint?.workflowId || "",
		providerId: hint?.providerId || "",
		laneId: hint?.laneId || "",
		firstUser,
		lastUser,
		lastAssistant,
	};
}

export function matchesSessionSummary(item: SessionSummary, query = ""): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [
		item.path,
		item.rawSessionId,
		item.cwd,
		item.repoName,
		item.sessionName,
		item.dashboardSessionId,
		item.workflowId,
		item.providerId,
		item.laneId,
		item.firstUser,
		item.lastUser,
		item.lastAssistant,
	]
		.filter(Boolean)
		.some((value) => String(value).toLowerCase().includes(needle));
}

function looksLikeRawSessionId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function findSessionFilesByRawId(rawSessionId: string, sessionRoot = DEFAULT_SESSION_ROOT): Promise<string[]> {
	const suffix = `_${rawSessionId}.jsonl`;
	const files = await walkFiles(sessionRoot, (file) => path.basename(file).endsWith(suffix));
	const ranked = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file).catch(() => null) })));
	return ranked
		.filter((item) => item.stat?.isFile())
		.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0))
		.map((item) => item.file);
}

export async function searchSessions(options: SessionSearchOptions = {}): Promise<SessionSummary[]> {
	const query = options.query || "";
	const limit = Math.max(1, Math.min(500, options.limit ?? 25));
	const hints = await loadRegistryHints(options.registryRoots);
	const files = await walkFiles(options.sessionRoot || DEFAULT_SESSION_ROOT, (file) => file.endsWith(".jsonl"));
	const ranked = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file).catch(() => null) })));
	const sorted = ranked
		.filter((item) => item.stat?.isFile())
		.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0));

	const out: SessionSummary[] = [];
	for (const item of sorted) {
		const parsed = await parseSessionSummary(item.file, hints);
		if (!parsed || !matchesSessionSummary(parsed, query)) continue;
		out.push(parsed);
		if (out.length >= limit) break;
	}
	return out;
}

export async function resolveSessionSpec(spec: string, options: SessionSearchOptions = {}): Promise<SessionSummary> {
	const query = spec.trim();
	if (!query) throw new Error("session spec is required");

	const directPath = path.resolve(query);
	if ((query.endsWith(".jsonl") || query.includes(path.sep)) && (await exists(directPath))) {
		const hints = await loadRegistryHints(options.registryRoots);
		const parsed = await parseSessionSummary(directPath, hints);
		if (!parsed) throw new Error(`Could not parse session file ${directPath}`);
		return parsed;
	}

	const hints = await loadRegistryHints(options.registryRoots);
	if (hints.bySessionId.has(query)) {
		const hint = hints.bySessionId.get(query);
		if (hint?.sessionFile && (await exists(hint.sessionFile))) {
			const parsed = await parseSessionSummary(hint.sessionFile, hints);
			if (parsed) return parsed;
		}
	}

	if (looksLikeRawSessionId(query)) {
		const files = await findSessionFilesByRawId(query, options.sessionRoot || DEFAULT_SESSION_ROOT);
		for (const file of files) {
			const parsed = await parseSessionSummary(file, hints);
			if (parsed?.rawSessionId === query) return parsed;
		}
	}

	const matches = await searchSessions({ ...options, query, limit: 20 });
	const exactRaw = matches.find((item) => item.rawSessionId === query);
	if (exactRaw) return exactRaw;
	const exactDashboard = matches.find((item) => item.dashboardSessionId === query);
	if (exactDashboard) return exactDashboard;

	if (!matches.length) throw new Error(`No Pi session found for ${JSON.stringify(query)}`);
	if (matches.length > 1) {
		const shortlist = matches.slice(0, 10).map((item) => ({
			path: item.path,
			rawSessionId: item.rawSessionId,
			dashboardSessionId: item.dashboardSessionId,
			sessionName: item.sessionName,
			providerId: item.providerId,
			workflowId: item.workflowId,
			updatedAt: item.updatedAt,
			lastUser: truncate(compactWhitespace(item.lastUser || item.firstUser || ""), 140),
		}));
		const error = new Error(`Multiple Pi sessions match ${JSON.stringify(query)}`);
		(error as Error & { matches?: unknown }).matches = shortlist;
		throw error;
	}
	return matches[0];
}

export async function loadActiveBranch(sessionFile: string): Promise<{ header: { id: string; version?: number; cwd?: string; timestamp?: string }; entries: TranscriptEntry[] }> {
	const text = await fs.readFile(sessionFile, "utf8").catch(() => "");
	if (!text) throw new Error(`Empty session file: ${sessionFile}`);

	const rows: TranscriptEntry[] = [];
	let header: TranscriptEntry | null = null;
	for (const line of text.split("\n").filter(Boolean)) {
		const item = safeJson<TranscriptEntry | null>(line, null);
		if (!item) continue;
		if (!header && item.type === "session") {
			header = item;
			continue;
		}
		rows.push(item);
	}

	if (!header?.id) throw new Error(`Invalid Pi session file: ${sessionFile}`);
	const byId = new Map(rows.filter((item) => item.id).map((item) => [item.id as string, item]));
	let activeLeaf: TranscriptEntry | null = null;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		if (rows[i]?.id) {
			activeLeaf = rows[i];
			break;
		}
	}

	const activeIds = new Set<string>();
	let cursor = activeLeaf;
	while (cursor?.id && !activeIds.has(cursor.id)) {
		activeIds.add(cursor.id);
		cursor = cursor.parentId ? byId.get(cursor.parentId) || null : null;
	}

	const branchEntries = activeIds.size ? rows.filter((item) => !item.id || activeIds.has(item.id)) : rows;
	return {
		header: {
			id: header.id,
			version: typeof header.version === "number" ? header.version : undefined,
			cwd: typeof header.cwd === "string" ? header.cwd : undefined,
			timestamp: typeof header.timestamp === "string" ? header.timestamp : undefined,
		},
		entries: branchEntries,
	};
}

export function normalizeEvents(entries: TranscriptEntry[]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		const timestampMs = Date.parse(entry.timestamp || "") || null;

		if (role === "user" || role === "assistant") {
			const text = messageText(entry.message);
			if (text) {
				events.push({
					kind: "message",
					role,
					id: entry.id || null,
					parentId: entry.parentId || null,
					timestamp: entry.timestamp || null,
					timestampMs,
					text,
					thinkingParts: contentStat(entry.message, "thinking"),
				});
			}

			for (const toolCall of messageToolCalls(entry.message)) {
				events.push({
					kind: "tool_call",
					role: "assistant",
					id: toolCall.id || null,
					parentMessageId: entry.id || null,
					timestamp: entry.timestamp || null,
					timestampMs,
					toolName: toolCall.name || "",
					toolCallId: toolCall.id || null,
					args: toolCall.arguments || {},
				});
			}
			continue;
		}

		if (role === "toolResult") {
			const text = messageText(entry.message, { includeThinking: false });
			events.push({
				kind: "tool_result",
				role,
				id: entry.id || null,
				parentId: entry.parentId || null,
				timestamp: entry.timestamp || null,
				timestampMs,
				toolName: entry.message.toolName || "",
				toolCallId: entry.message.toolCallId || null,
				text,
				isError: Boolean(entry.message.isError),
				details: entry.message.details,
			});
		}
	}
	return events;
}

function extractExitCode(text: string | undefined): number | null {
	const match = String(text || "").match(/Command exited with code (\d+)/);
	return match ? Number(match[1]) : null;
}

export function summarizeArgs(toolName: string | undefined, args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	if (toolName === "bash") return String(args.command || "");
	if (toolName === "read" || toolName === "write" || toolName === "edit") return String(args.path || args.file_path || "");
	return JSON.stringify(args);
}

export function buildToolInvocations(events: TranscriptEvent[]): ToolInvocation[] {
	const out: ToolInvocation[] = [];
	const byToolCallId = new Map<string, ToolInvocation>();

	for (const event of events) {
		if (event.kind === "tool_call") {
			const invocation: ToolInvocation = {
				toolCallId: event.toolCallId || null,
				toolName: event.toolName || "",
				startedAt: event.timestamp,
				startedAtMs: event.timestampMs,
				args: event.args || {},
				argsSummary: summarizeArgs(event.toolName, event.args),
				callEvent: event,
				resultEvent: null,
				status: "pending",
				failed: false,
				exitCode: null,
			};
			out.push(invocation);
			if (event.toolCallId) byToolCallId.set(event.toolCallId, invocation);
			continue;
		}

		if (event.kind === "tool_result") {
			let invocation = event.toolCallId ? byToolCallId.get(event.toolCallId) || null : null;
			if (!invocation) {
				invocation = {
					toolCallId: event.toolCallId || null,
					toolName: event.toolName || "",
					startedAt: event.timestamp,
					startedAtMs: event.timestampMs,
					args: {},
					argsSummary: "",
					callEvent: null,
					resultEvent: null,
					status: "pending",
					failed: false,
					exitCode: null,
				};
				out.push(invocation);
				if (event.toolCallId) byToolCallId.set(event.toolCallId, invocation);
			}
			invocation.resultEvent = event;
			invocation.endedAt = event.timestamp;
			invocation.endedAtMs = event.timestampMs;
			invocation.exitCode = extractExitCode(event.text);
			invocation.failed = Boolean(event.isError);
			invocation.status = invocation.failed ? "error" : "ok";
		}
	}
	return out;
}

export function buildTurns(events: TranscriptEvent[]): Turn[] {
	const turns: Turn[] = [];
	let current: Omit<Turn, "endedAt" | "endedAtMs" | "assistantMessages" | "toolInvocations" | "failures" | "finalAssistant"> | null = null;

	for (const event of events) {
		if (event.kind === "message" && event.role === "user") {
			if (current) turns.push(finalizeTurn(current));
			current = {
				index: turns.length + 1,
				startedAt: event.timestamp,
				startedAtMs: event.timestampMs,
				events: [event],
				user: event,
			};
			continue;
		}
		if (!current) continue;
		current.events.push(event);
	}
	if (current) turns.push(finalizeTurn(current));
	return turns;
}

function finalizeTurn(turn: Omit<Turn, "endedAt" | "endedAtMs" | "assistantMessages" | "toolInvocations" | "failures" | "finalAssistant">): Turn {
	const toolInvocations = buildToolInvocations(turn.events);
	const assistantMessages = turn.events.filter((event) => event.kind === "message" && event.role === "assistant");
	const failures = toolInvocations.filter((item) => item.failed);
	const lastEvent = turn.events[turn.events.length - 1] || turn.user;
	return {
		...turn,
		endedAt: lastEvent.timestamp || turn.startedAt,
		endedAtMs: lastEvent.timestampMs || turn.startedAtMs,
		assistantMessages,
		toolInvocations,
		failures,
		finalAssistant: assistantMessages[assistantMessages.length - 1] || null,
	};
}

export function inWindow(timestampMs: number | null | undefined, window: TimeWindow = {}): boolean {
	if (!timestampMs) return false;
	if (window.since !== null && window.since !== undefined && timestampMs < window.since) return false;
	if (window.until !== null && window.until !== undefined && timestampMs > window.until) return false;
	return true;
}

export function tail<T>(items: T[], count: number): T[] {
	if (!count || count <= 0) return items;
	return items.slice(-count);
}

export async function loadSessionDataForSession(session: SessionSummary): Promise<SessionData> {
	const transcript = await loadActiveBranch(session.path);
	const events = normalizeEvents(transcript.entries);
	const toolInvocations = buildToolInvocations(events);
	const turns = buildTurns(events);
	return { session, transcript, events, toolInvocations, turns };
}

export async function loadSessionData(spec: string, options: SessionSearchOptions = {}): Promise<SessionData> {
	const session = await resolveSessionSpec(spec, options);
	return loadSessionDataForSession(session);
}

export function renderToolLine(item: ToolInvocation): string {
	const status = item.failed ? "ERROR" : item.status.toUpperCase();
	const command = item.argsSummary ? `\n  ${item.argsSummary}` : "";
	const result = item.resultEvent?.text ? `\n  result: ${truncate(compactWhitespace(item.resultEvent.text), 220)}` : "";
	return `${formatTimestamp(item.startedAt)} · ${status} · ${item.toolName}${command}${result}`;
}
