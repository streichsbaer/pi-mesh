export type DeliveryMode = "auto" | "prompt" | "steer" | "follow-up";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelSelection {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface SessionSummary {
	path: string;
	rawSessionId: string;
	cwd: string;
	repoName: string;
	timestamp: string | null;
	updatedAt: number;
	sessionName: string;
	dashboardSessionId: string;
	workflowId: string;
	providerId: string;
	laneId: string;
	firstUser: string;
	lastUser: string;
	lastAssistant: string;
}

export interface TranscriptHeader {
	id: string;
	version?: number;
	cwd?: string;
	timestamp?: string;
}

export interface TranscriptEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: AgentMessageLike;
	[key: string]: unknown;
}

export interface AgentMessageLike {
	role?: string;
	content?: string | ContentPartLike[];
	toolName?: string;
	toolCallId?: string | null;
	isError?: boolean;
	details?: unknown;
	[key: string]: unknown;
}

export type ContentPartLike =
	| { type: "text"; text?: string }
	| { type: "thinking"; thinking?: string }
	| { type: "toolCall"; id?: string; name?: string; arguments?: Record<string, unknown> }
	| { type: string; [key: string]: unknown };

export interface TranscriptEvent {
	kind: "message" | "tool_call" | "tool_result";
	role: string;
	id: string | null;
	parentId?: string | null;
	parentMessageId?: string | null;
	timestamp: string | null;
	timestampMs: number | null;
	text?: string;
	thinkingParts?: number;
	toolName?: string;
	toolCallId?: string | null;
	args?: Record<string, unknown>;
	isError?: boolean;
	details?: unknown;
}

export interface ToolInvocation {
	toolCallId: string | null;
	toolName: string;
	startedAt: string | null;
	startedAtMs: number | null;
	endedAt?: string | null;
	endedAtMs?: number | null;
	args: Record<string, unknown>;
	argsSummary: string;
	callEvent: TranscriptEvent | null;
	resultEvent: TranscriptEvent | null;
	status: "pending" | "ok" | "error";
	failed: boolean;
	exitCode: number | null;
}

export interface Turn {
	index: number;
	startedAt: string | null;
	startedAtMs: number | null;
	endedAt: string | null;
	endedAtMs: number | null;
	events: TranscriptEvent[];
	user: TranscriptEvent;
	assistantMessages: TranscriptEvent[];
	toolInvocations: ToolInvocation[];
	failures: ToolInvocation[];
	finalAssistant: TranscriptEvent | null;
}

export interface SessionData {
	session: SessionSummary;
	transcript: {
		header: TranscriptHeader;
		entries: TranscriptEntry[];
	};
	events: TranscriptEvent[];
	toolInvocations: ToolInvocation[];
	turns: Turn[];
}

export type ManagedSessionKind = "interactive" | "sleeping" | "attached";
export type ManagedSessionStatus = "offline" | "starting" | "running" | "idle" | "busy" | "error";

export interface ManagedSessionRecord {
	meshId: string;
	name?: string;
	kind: ManagedSessionKind;
	status: ManagedSessionStatus;
	cwd: string;
	sessionFile: string;
	rawSessionId?: string;
	pid?: number;
	socketPath?: string;
	createdAt: string;
	updatedAt: string;
	lastError?: string;
	pendingModelSelection?: ModelSelection;
}

export interface WorkspacePaths {
	id: string;
	root: string;
	baseDir: string;
	registryFile: string;
	inboxDir: string;
	locksDir: string;
}
