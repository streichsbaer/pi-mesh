import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { hasModelSelection } from "./model-selection.js";
import type { DeliveryMode, ModelSelection } from "./types.js";
import { ensurePrivateDir } from "./utils.js";

interface SocketSendRequest {
	id?: string;
	type: "send";
	message: string;
	delivery?: DeliveryMode;
	modelSelection?: ModelSelection;
}

export interface LiveSocketSession {
	isStreaming: boolean;
	agent: { waitForIdle: () => Promise<void> };
}

export interface StartSessionSocketOptions<TSession extends LiveSocketSession> {
	socketPath: string;
	getSession: () => TSession;
	deliverToSession: (session: TSession, message: string, delivery: DeliveryMode) => Promise<void>;
	applyModelSelection: (session: TSession, selection: ModelSelection | undefined) => Promise<void>;
	onStatus?: (status: "busy" | "idle" | "error", error?: string) => Promise<void> | void;
}

export async function startSessionSocket<TSession extends LiveSocketSession>(options: StartSessionSocketOptions<TSession>): Promise<net.Server> {
	await ensurePrivateDir(path.dirname(options.socketPath));
	await fs.rm(options.socketPath, { force: true }).catch(() => undefined);

	let queue = Promise.resolve();
	const enqueue = (task: () => Promise<void>) => {
		queue = queue.then(task, task);
		void queue;
	};

	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => undefined); // Keep the live session running if a client disconnects.
		socket.on("data", (chunk) => {
			buffer += chunk;
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

				enqueue(async () => {
					let markedBusy = false;
					try {
						const session = options.getSession();
						if (hasModelSelection(request.modelSelection) && session.isStreaming) {
							throw new Error("Cannot change model or thinking level while target session is busy; wait until idle or send without model options.");
						}
						await options.applyModelSelection(session, request.modelSelection);
						await options.onStatus?.("busy");
						markedBusy = true;
						await options.deliverToSession(session, request.message, request.delivery ?? "auto");
						await session.agent.waitForIdle();
						await options.onStatus?.("idle");
						socket.write(`${JSON.stringify({ id: request.id, type: "response", success: true })}\n`);
					} catch (error) {
						if (markedBusy) await options.onStatus?.("error", (error as Error).message);
						socket.write(
							`${JSON.stringify({ id: request.id, type: "response", success: false, error: (error as Error).message })}\n`,
						);
					}
				});
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return server;
}

export async function sendToLiveSocket(
	socketPath: string,
	message: string,
	delivery: DeliveryMode = "auto",
	modelSelection?: ModelSelection,
	timeoutMs = 0,
): Promise<void> {
	const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const request: SocketSendRequest = { id, type: "send", message, delivery, modelSelection };

	await new Promise<void>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const timer = timeoutMs > 0
			? setTimeout(() => finish(new Error(`Socket request timed out after ${timeoutMs}ms`)), timeoutMs)
			: undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolve();
			socket.destroy();
		};

		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.once("error", (error) => finish(error));
		socket.once("end", () => finish(new Error("Socket closed before response")));
		socket.once("close", () => finish(new Error("Socket closed before response")));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = buffer.slice(0, newlineIndex).trim();
			try {
				const response = JSON.parse(line) as { success?: boolean; error?: string };
				if (response.success) finish();
				else finish(new Error(response.error || "Socket request failed"));
			} catch (error) {
				finish(error as Error);
			}
		});
	});
}
