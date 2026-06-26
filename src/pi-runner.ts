import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
	createAgentSession,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	InteractiveMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type DeliveryMode, type ModelSelection, type ThinkingLevel } from "./types.js";

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

interface SocketSendRequest {
	id?: string;
	type: "send";
	message: string;
	delivery?: DeliveryMode;
	modelSelection?: ModelSelection;
}

type AgentSessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];
type AgentSessionServices = Awaited<ReturnType<typeof createAgentSessionServices>>;
type SessionStartEvent = Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];
type ModelRegistry = AgentSessionInstance["modelRegistry"];
type PiModel = ReturnType<ModelRegistry["getAll"]>[number];

interface SessionContextSnapshot {
	messages: unknown[];
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	hasThinkingEntry: boolean;
}

interface ResolvedModelSelection {
	model?: PiModel;
	thinkingLevel?: ThinkingLevel;
	explicitModel: boolean;
	explicitThinking: boolean;
}

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function hasModelSelection(selection: ModelSelection | undefined): selection is ModelSelection {
	return Boolean(selection?.provider || selection?.model || selection?.thinkingLevel);
}

function formatModelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function modelMatches(model: { provider: string; id: string } | undefined, other: { provider: string; id: string }): boolean {
	return model?.provider === other.provider && model.id === other.id;
}

function splitModelThinking(modelRef: string): { modelRef: string; thinkingLevel?: ThinkingLevel } {
	const colonIndex = modelRef.lastIndexOf(":");
	if (colonIndex > 0) {
		const suffix = modelRef.slice(colonIndex + 1);
		if (isThinkingLevel(suffix)) return { modelRef: modelRef.slice(0, colonIndex), thinkingLevel: suffix };
	}
	return { modelRef };
}

function selectUniqueModel(matches: PiModel[], requested: string): PiModel | undefined {
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];
	const examples = matches.slice(0, 8).map(formatModelRef).join(", ");
	const suffix = matches.length > 8 ? `, ... ${matches.length - 8} more` : "";
	throw new Error(`Model ${JSON.stringify(requested)} is ambiguous. Use provider/model. Matches: ${examples}${suffix}`);
}

function resolveModelRef(modelRegistry: ModelRegistry, requested: string, providerInput: string | undefined): PiModel {
	const models = modelRegistry.getAll();
	if (models.length === 0) throw new Error("No models available. Check your Pi installation or models.json.");

	const providerMap = new Map<string, string>();
	for (const model of models) providerMap.set(model.provider.toLowerCase(), model.provider);

	let provider = providerInput ? providerMap.get(providerInput.toLowerCase()) : undefined;
	if (providerInput && !provider) {
		throw new Error(`Unknown provider ${JSON.stringify(providerInput)}. Use \`pi --list-models\` to see available providers/models.`);
	}

	let pattern = requested;
	if (provider && requested.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
		pattern = requested.slice(provider.length + 1);
	}

	if (!provider) {
		const slashIndex = requested.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = requested.slice(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = requested.slice(slashIndex + 1);
			}
		}
	}

	const candidates = provider ? models.filter((model) => model.provider === provider) : models;
	const normalized = pattern.toLowerCase();
	const exact = selectUniqueModel(
		candidates.filter((model) => {
			const id = model.id.toLowerCase();
			const canonical = formatModelRef(model).toLowerCase();
			return id === normalized || canonical === requested.toLowerCase();
		}),
		requested,
	);
	if (exact) return exact;

	const fuzzy = selectUniqueModel(
		candidates.filter((model) => model.id.toLowerCase().includes(normalized) || model.name?.toLowerCase().includes(normalized)),
		requested,
	);
	if (fuzzy) return fuzzy;

	const display = provider ? `${provider}/${pattern}` : requested;
	throw new Error(`Model ${JSON.stringify(display)} not found. Use \`pi --list-models\` to see available models.`);
}

function resolveRequestedModelSelection(modelRegistry: ModelRegistry, selection: ModelSelection | undefined): ResolvedModelSelection {
	const provider = selection?.provider?.trim();
	const modelInput = selection?.model?.trim();
	if (provider && !modelInput) throw new Error("--provider requires --model.");

	let model: PiModel | undefined;
	const requestedThinking = selection?.thinkingLevel;
	if (requestedThinking !== undefined && !isThinkingLevel(String(requestedThinking))) {
		throw new Error(`Invalid --thinking ${JSON.stringify(requestedThinking)}. Expected: ${THINKING_LEVELS.join(", ")}.`);
	}
	let thinkingLevel = requestedThinking;
	let explicitThinking = thinkingLevel !== undefined;
	if (modelInput) {
		try {
			model = resolveModelRef(modelRegistry, modelInput, provider);
		} catch (error) {
			const split = splitModelThinking(modelInput);
			if (split.thinkingLevel === undefined) throw error;
			const modelRef = split.modelRef.trim();
			if (!modelRef) throw new Error("--model requires a non-empty value.");
			model = resolveModelRef(modelRegistry, modelRef, provider);
			thinkingLevel = thinkingLevel ?? split.thinkingLevel;
			explicitThinking = true;
		}
		if (!modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key/auth configured for ${formatModelRef(model)}.`);
		}
	}

	return {
		model,
		thinkingLevel,
		explicitModel: modelInput !== undefined,
		explicitThinking,
	};
}

function getSessionContextSnapshot(sessionManager: SessionManager): SessionContextSnapshot {
	const context = sessionManager.buildSessionContext();
	return {
		messages: context.messages,
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		hasThinkingEntry: sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change"),
	};
}

function restoreModelFromSession(modelRegistry: ModelRegistry, snapshot: SessionContextSnapshot): PiModel | undefined {
	if (!snapshot.model) return undefined;
	const model = modelRegistry.find(snapshot.model.provider, snapshot.model.modelId);
	return model && modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

function resolveSessionModelSelection(
	modelRegistry: ModelRegistry,
	snapshot: SessionContextSnapshot,
	selection: ModelSelection | undefined,
): ResolvedModelSelection {
	const resolved = resolveRequestedModelSelection(modelRegistry, selection);
	if (!resolved.model && !resolved.explicitModel) resolved.model = restoreModelFromSession(modelRegistry, snapshot);
	if (!resolved.thinkingLevel && !resolved.explicitThinking && snapshot.hasThinkingEntry && isThinkingLevel(snapshot.thinkingLevel)) {
		resolved.thinkingLevel = snapshot.thinkingLevel;
	}
	return resolved;
}

function persistThinkingLevelIfNeeded(session: AgentSessionInstance, thinkingLevel: ThinkingLevel): void {
	if (session.thinkingLevel !== thinkingLevel) {
		session.setThinkingLevel(thinkingLevel);
		return;
	}
	if (session.sessionManager.buildSessionContext().thinkingLevel !== thinkingLevel) {
		session.sessionManager.appendThinkingLevelChange(thinkingLevel);
	}
}

async function persistExplicitSelectionIfNeeded(
	session: AgentSessionInstance,
	snapshot: SessionContextSnapshot,
	resolved: ResolvedModelSelection,
): Promise<void> {
	const hadMessages = snapshot.messages.length > 0;
	if (hadMessages && resolved.explicitModel && resolved.model) {
		const saved = snapshot.model;
		if (!saved || saved.provider !== resolved.model.provider || saved.modelId !== resolved.model.id) {
			await session.setModel(resolved.model);
		}
	}

	if (hadMessages && resolved.explicitThinking && resolved.thinkingLevel && snapshot.thinkingLevel !== resolved.thinkingLevel) {
		persistThinkingLevelIfNeeded(session, resolved.thinkingLevel);
	}
}

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

async function startSessionSocket(
	socketPath: string,
	getSession: () => Awaited<ReturnType<typeof createAgentSessionRuntime>>["session"],
	onStatus?: RunInteractiveOptions["onStatus"],
): Promise<net.Server> {
	await fs.mkdir(path.dirname(socketPath), { recursive: true });
	await fs.rm(socketPath, { force: true }).catch(() => undefined);

	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => undefined); // Keep the live session running if a client disconnects.
		socket.on("data", (chunk) => {
			buffer += chunk;
			void (async () => {
				while (true) {
					const newlineIndex = buffer.indexOf("\n");
					if (newlineIndex === -1) return;
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (!line) continue;

					let request: SocketSendRequest;
					try {
						request = JSON.parse(line) as SocketSendRequest;
						if (request.type !== "send" || !request.message) throw new Error("Expected send request with message");
					} catch (error) {
						socket.write(`${JSON.stringify({ type: "response", success: false, error: (error as Error).message })}\n`);
						continue;
					}

					let markedBusy = false;
					try {
						if (hasModelSelection(request.modelSelection) && getSession().isStreaming) {
							throw new Error("Cannot change model or thinking level while target session is busy; wait until idle or send without model options.");
						}
						await applyModelSelectionToLiveSession(getSession(), request.modelSelection);
						await onStatus?.("busy");
						markedBusy = true;
						await deliverToSession(getSession(), request.message, request.delivery ?? "auto");
						await getSession().agent.waitForIdle();
						await onStatus?.("idle");
						socket.write(`${JSON.stringify({ id: request.id, type: "response", success: true })}\n`);
					} catch (error) {
						if (markedBusy) await onStatus?.("error", (error as Error).message);
						socket.write(
							`${JSON.stringify({ id: request.id, type: "response", success: false, error: (error as Error).message })}\n`,
						);
					}
				}
			})();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return server;
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

	let server: net.Server | undefined;
	let unsubscribeMaterialized: (() => void) | undefined;
	try {
		await options.onSessionFile?.(runtime.session.sessionFile, runtime.session.sessionId);
		await options.onStatus?.("running");
		unsubscribeMaterialized = runtime.session.subscribe((event) => {
			if (event.type === "agent_end" && !event.willRetry) void options.onMaterialized?.();
		});
		if (options.socketPath) {
			server = await startSessionSocket(options.socketPath, () => runtime.session, options.onStatus);
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
		if (options.socketPath) await fs.rm(options.socketPath, { force: true }).catch(() => undefined);
		await runtime.dispose();
	}
}

export async function sendToLiveSocket(
	socketPath: string,
	message: string,
	delivery: DeliveryMode = "auto",
	modelSelection?: ModelSelection,
): Promise<void> {
	const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const request: SocketSendRequest = { id, type: "send", message, delivery, modelSelection };

	await new Promise<void>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.once("error", reject);
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = buffer.slice(0, newlineIndex).trim();
			try {
				const response = JSON.parse(line) as { success?: boolean; error?: string };
				if (response.success) resolve();
				else reject(new Error(response.error || "Socket request failed"));
			} catch (error) {
				reject(error);
			} finally {
				socket.end();
			}
		});
	});
}
