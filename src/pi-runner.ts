import { promises as fs } from "node:fs";
import type { Server as NetServer } from "node:net";
import path from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	InteractiveMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	getSessionContextSnapshot,
	hasModelSelection,
	isThinkingLevel,
	modelMatches,
	persistExplicitSelectionIfNeeded,
	persistThinkingLevelIfNeeded,
	resolveRequestedModelSelection,
	resolveSessionModelSelection,
} from "./model-selection.js";
import { startSessionSocket } from "./live-socket.js";
import type { DeliveryMode, ModelSelection } from "./types.js";
export { sendToLiveSocket } from "./live-socket.js";

interface RunHeadlessTurnOptions {
	cwd: string;
	sessionFile?: string;
	message: string;
	delivery?: DeliveryMode;
	stream?: boolean;
	modelSelection?: ModelSelection;
}

interface RunInteractiveOptions {
	cwd: string;
	sessionFile?: string;
	name?: string;
	initialMessage?: string;
	socketPath?: string;
	modelSelection?: ModelSelection;
	onSessionFile?: (sessionFile: string | undefined, rawSessionId: string) => Promise<void> | void;
	onMaterialized?: () => Promise<void> | void;
	onStatus?: (status: "running" | "idle" | "busy" | "offline" | "error", error?: string) => Promise<void> | void;
}

interface CreatePersistentSessionOptions {
	cwd: string;
	name?: string;
	modelSelection?: ModelSelection;
}

type AgentSessionInstance = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
type AgentSessionServices = Awaited<ReturnType<typeof createAgentSessionServices>>;
type SessionStartEvent = Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];

async function createAgentSessionWithModelSelection(options: {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	modelSelection?: ModelSelection;
}): ReturnType<typeof createAgentSessionFromServices> {
	const snapshot = getSessionContextSnapshot(options.sessionManager);
	const resolved = resolveSessionModelSelection(options.services.modelRegistry, snapshot, options.modelSelection);
	const thinkingLevelForCreate = snapshot.messages.length > 0 && resolved.explicitThinking && snapshot.hasThinkingEntry && isThinkingLevel(snapshot.thinkingLevel)
		? snapshot.thinkingLevel
		: resolved.thinkingLevel;
	const created = await createAgentSessionFromServices({
		services: options.services,
		sessionManager: options.sessionManager,
		sessionStartEvent: options.sessionStartEvent,
		model: resolved.model,
		thinkingLevel: thinkingLevelForCreate,
	});
	await persistExplicitSelectionIfNeeded(created.session, snapshot, resolved);
	return created;
}

async function applyModelSelectionToLiveSession(session: AgentSessionInstance, selection: ModelSelection | undefined): Promise<void> {
	if (!hasModelSelection(selection)) return;
	const resolved = resolveRequestedModelSelection(session.modelRegistry, selection);
	if (resolved.model && !modelMatches(session.model, resolved.model)) await session.setModel(resolved.model);
	if (resolved.thinkingLevel) persistThinkingLevelIfNeeded(session, resolved.thinkingLevel);
}

export async function validateModelSelection(options: { cwd: string; modelSelection?: ModelSelection }): Promise<ModelSelection | undefined> {
	if (!hasModelSelection(options.modelSelection)) return undefined;
	const services = await createAgentSessionServices({ cwd: options.cwd });
	const resolved = resolveRequestedModelSelection(services.modelRegistry, options.modelSelection);
	return {
		provider: resolved.model?.provider,
		model: resolved.model?.id,
		thinkingLevel: resolved.thinkingLevel,
	};
}

async function deliverToSession(
	session: AgentSessionInstance,
	message: string,
	delivery: DeliveryMode = "auto",
): Promise<void> {
	if (delivery === "auto") {
		if (session.isStreaming) await session.followUp(message);
		else await session.prompt(message);
		return;
	}

	if (delivery === "steer") {
		if (session.isStreaming) await session.steer(message);
		else await session.prompt(message);
		return;
	}

	if (delivery === "follow-up") {
		if (session.isStreaming) await session.followUp(message);
		else await session.prompt(message);
		return;
	}

	if (delivery === "prompt") {
		if (session.isStreaming) {
			throw new Error("Target session is streaming; use --delivery steer, follow-up, or auto.");
		}
		await session.prompt(message);
		return;
	}

	throw new Error(`Unsupported delivery mode: ${delivery}`);
}

export async function createPersistentSession(
	options: CreatePersistentSessionOptions,
): Promise<{ sessionFile?: string; rawSessionId: string }> {
	const sessionManager = SessionManager.create(options.cwd);
	if (options.name) sessionManager.appendSessionInfo(options.name);
	const services = await createAgentSessionServices({ cwd: options.cwd });
	const { session } = await createAgentSessionWithModelSelection({ services, sessionManager, modelSelection: options.modelSelection });
	try {
		return { sessionFile: session.sessionFile, rawSessionId: session.sessionId };
	} finally {
		session.dispose();
	}
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
	if (!filePath) return false;
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function runHeadlessTurn(options: RunHeadlessTurnOptions): Promise<{ sessionFile?: string; rawSessionId: string }> {
	const sessionManager = options.sessionFile && (await fileExists(options.sessionFile))
		? SessionManager.open(options.sessionFile)
		: SessionManager.create(options.cwd);
	const services = await createAgentSessionServices({ cwd: options.cwd });
	const { session } = await createAgentSessionWithModelSelection({ services, sessionManager, modelSelection: options.modelSelection });

	try {
		if (options.stream) {
			session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					process.stdout.write(event.assistantMessageEvent.delta);
				}
			});
		}

		await deliverToSession(session, options.message, options.delivery ?? "auto");
		await session.agent.waitForIdle();
		if (options.stream) process.stdout.write("\n");
		return { sessionFile: session.sessionFile, rawSessionId: session.sessionId };
	} finally {
		session.dispose();
	}
}

function createRuntimeFactory(modelSelection?: ModelSelection): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd });
		return {
			...(await createAgentSessionWithModelSelection({ services, sessionManager, sessionStartEvent, modelSelection })),
			services,
			diagnostics: services.diagnostics,
		};
	};
}

export async function runInteractive(options: RunInteractiveOptions): Promise<void> {
	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile)
		: SessionManager.create(options.cwd);
	if (options.name) sessionManager.appendSessionInfo(options.name);

	const runtime = await createAgentSessionRuntime(createRuntimeFactory(options.modelSelection), {
		cwd: options.cwd,
		agentDir: getAgentDir(),
		sessionManager,
	});

	let server: NetServer | undefined;
	let unsubscribeMaterialized: (() => void) | undefined;
	try {
		await options.onSessionFile?.(runtime.session.sessionFile, runtime.session.sessionId);
		await options.onStatus?.("running");
		unsubscribeMaterialized = runtime.session.subscribe((event) => {
			if (event.type === "agent_end" && !event.willRetry) void options.onMaterialized?.();
		});
		if (options.socketPath) {
			server = await startSessionSocket({
				socketPath: options.socketPath,
				getSession: () => runtime.session,
				applyModelSelection: applyModelSelectionToLiveSession,
				deliverToSession,
				onStatus: options.onStatus,
			});
		}

		const mode = new InteractiveMode(runtime, {
			migratedProviders: [],
			modelFallbackMessage: undefined,
			initialMessage: options.initialMessage,
			initialImages: [],
			initialMessages: [],
		});
		await mode.run();
	} finally {
		unsubscribeMaterialized?.();
		await options.onStatus?.("offline");
		const activeServer = server;
		if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
		if (options.socketPath) {
			await fs.rm(options.socketPath, { force: true }).catch(() => undefined);
			await fs.rmdir(path.dirname(options.socketPath)).catch(() => undefined);
			await fs.rmdir(path.dirname(path.dirname(options.socketPath))).catch(() => undefined);
		}
		await runtime.dispose();
	}
}
