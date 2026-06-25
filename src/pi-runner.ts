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
import type { DeliveryMode } from "./types.js";

interface RunHeadlessTurnOptions {
	cwd: string;
	sessionFile?: string;
	message: string;
	delivery?: DeliveryMode;
	stream?: boolean;
}

interface RunInteractiveOptions {
	cwd: string;
	sessionFile?: string;
	name?: string;
	initialMessage?: string;
	socketPath?: string;
	onSessionFile?: (sessionFile: string | undefined, rawSessionId: string) => Promise<void> | void;
	onStatus?: (status: "running" | "idle" | "busy" | "offline" | "error", error?: string) => Promise<void> | void;
}

interface CreatePersistentSessionOptions {
	cwd: string;
	name?: string;
}

interface SocketSendRequest {
	id?: string;
	type: "send";
	message: string;
	delivery?: DeliveryMode;
}

async function deliverToSession(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
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
	const { session } = await createAgentSession({ cwd: options.cwd, sessionManager });
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
	const { session } = await createAgentSession({ cwd: options.cwd, sessionManager });

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

function createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd });
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
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

					try {
						await onStatus?.("busy");
						await deliverToSession(getSession(), request.message, request.delivery ?? "auto");
						await getSession().agent.waitForIdle();
						await onStatus?.("idle");
						socket.write(`${JSON.stringify({ id: request.id, type: "response", success: true })}\n`);
					} catch (error) {
						await onStatus?.("error", (error as Error).message);
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

	const runtime = await createAgentSessionRuntime(createRuntimeFactory(), {
		cwd: options.cwd,
		agentDir: getAgentDir(),
		sessionManager,
	});

	let server: net.Server | undefined;
	try {
		await options.onSessionFile?.(runtime.session.sessionFile, runtime.session.sessionId);
		await options.onStatus?.("running");
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
): Promise<void> {
	const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const request: SocketSendRequest = { id, type: "send", message, delivery };

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
