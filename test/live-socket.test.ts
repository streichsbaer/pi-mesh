import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendToLiveSocket, startSessionSocket } from "../src/live-socket.js";

const tempDirs: string[] = [];

async function socketPath(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-mesh-socket-"));
	tempDirs.push(dir);
	return path.join(dir, "session.sock");
}

function fakeSession(options: { streaming?: boolean; promptError?: Error } = {}) {
	return {
		isStreaming: options.streaming ?? false,
		prompt: vi.fn(async (_message: string) => {
			if (options.promptError) throw options.promptError;
		}),
		steer: vi.fn(async (_message: string) => undefined),
		followUp: vi.fn(async (_message: string) => undefined),
		agent: { waitForIdle: vi.fn(async () => undefined) },
	};
}

function socketOptions(
	socket: string,
	session: ReturnType<typeof fakeSession>,
	onStatus?: (status: "busy" | "idle" | "error", error?: string) => void,
) {
	return {
		socketPath: socket,
		getSession: () => session,
		applyModelSelection: async () => undefined,
		deliverToSession: async (target: ReturnType<typeof fakeSession>, message: string, delivery: string) => {
			if (delivery === "prompt" || delivery === "auto") await target.prompt(message);
			else if (delivery === "steer") await target.steer(message);
			else if (delivery === "follow-up") await target.followUp(message);
			else throw new Error(`Unexpected delivery ${delivery}`);
		},
		onStatus,
	};
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("live socket", () => {
	it("delivers live messages and reports busy then idle", async () => {
		const socket = await socketPath();
		const session = fakeSession();
		const statuses: string[] = [];
		const server = await startSessionSocket(socketOptions(socket, session, (status) => statuses.push(status)));
		try {
			await sendToLiveSocket(socket, "hello", "prompt");

			expect(session.prompt).toHaveBeenCalledWith("hello");
			expect(session.agent.waitForIdle).toHaveBeenCalledTimes(1);
			expect(statuses).toEqual(["busy", "idle"]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("rejects malformed requests without stopping the server", async () => {
		const socket = await socketPath();
		const session = fakeSession();
		const server = await startSessionSocket(socketOptions(socket, session));
		try {
			const malformedResponse = await new Promise<any>((resolve, reject) => {
				const client = net.createConnection(socket);
				let buffer = "";
				client.setEncoding("utf8");
				client.once("error", reject);
				client.once("connect", () => client.write("not json\n"));
				client.on("data", (chunk) => {
					buffer += chunk;
					const newlineIndex = buffer.indexOf("\n");
					if (newlineIndex === -1) return;
					client.end();
					resolve(JSON.parse(buffer.slice(0, newlineIndex)));
				});
			});
			expect(malformedResponse.success).toBe(false);
			expect(malformedResponse.error).toContain("Unexpected token");

			await sendToLiveSocket(socket, "still alive", "prompt");
			expect(session.prompt).toHaveBeenCalledWith("still alive");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("rejects model changes while the target session is busy", async () => {
		const socket = await socketPath();
		const session = fakeSession({ streaming: true });
		const statuses: string[] = [];
		const server = await startSessionSocket(socketOptions(socket, session, (status) => statuses.push(status)));
		try {
			await expect(sendToLiveSocket(socket, "change model", "prompt", { thinkingLevel: "high" })).rejects.toThrow(
				"Cannot change model or thinking level while target session is busy",
			);
			expect(session.prompt).not.toHaveBeenCalled();
			expect(statuses).toEqual([]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("rejects when the server closes before sending a response", async () => {
		const socket = await socketPath();
		const server = net.createServer((client) => client.destroy());
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socket, () => resolve());
		});
		try {
			await expect(sendToLiveSocket(socket, "hello", "prompt", undefined, 500)).rejects.toThrow(/Socket (closed before response|request timed out)|EPIPE/);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("serializes concurrent send requests for one live session", async () => {
		const socket = await socketPath();
		const session = fakeSession();
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const server = await startSessionSocket({
			socketPath: socket,
			getSession: () => session,
			applyModelSelection: async () => undefined,
			deliverToSession: async (_target, message) => {
				events.push(`start:${message}`);
				if (message === "one") await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
				events.push(`end:${message}`);
			},
		});
		try {
			const first = sendToLiveSocket(socket, "one", "prompt");
			await waitFor(() => events.includes("start:one"), "first request to start");
			const second = sendToLiveSocket(socket, "two", "prompt");
			await sleep(50);
			expect(events).toEqual(["start:one"]);
			releaseFirst?.();
			await Promise.all([first, second]);
			expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
		} finally {
			releaseFirst?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("records error status for delivery failures after marking busy", async () => {
		const socket = await socketPath();
		const session = fakeSession({ promptError: new Error("provider failed") });
		const statuses: Array<{ status: string; error?: string }> = [];
		const server = await startSessionSocket(socketOptions(socket, session, (status, error) => statuses.push({ status, error })));
		try {
			await expect(sendToLiveSocket(socket, "hello", "prompt")).rejects.toThrow("provider failed");
			expect(statuses).toEqual([
				{ status: "busy", error: undefined },
				{ status: "error", error: "provider failed" },
			]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
