import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	InteractiveMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject() {
	const root = await mkdtemp(path.join(tmpdir(), "pi-mesh-sdk-contract-"));
	tempDirs.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { cwd, agentDir };
}

describe("Pi SDK contract", () => {
	it("exports the public runtime/session APIs used by pi-mesh", () => {
		expect(typeof createAgentSessionServices).toBe("function");
		expect(typeof createAgentSessionFromServices).toBe("function");
		expect(typeof createAgentSessionRuntime).toBe("function");
		expect(typeof getAgentDir).toBe("function");
		expect(typeof InteractiveMode).toBe("function");
		expect(typeof SessionManager.create).toBe("function");
		expect(typeof SessionManager.open).toBe("function");
	});

	it("creates cwd-scoped services with the registry/settings methods pi-mesh relies on", async () => {
		const { cwd, agentDir } = await tempProject();

		expect(getAgentDir()).toBe(agentDir);
		const services = await createAgentSessionServices({ cwd });

		expect(services.cwd).toBe(cwd);
		expect(Array.isArray(services.diagnostics)).toBe(true);
		expect(typeof services.modelRegistry.getAll).toBe("function");
		expect(typeof services.modelRegistry.getAvailable).toBe("function");
		expect(typeof services.modelRegistry.find).toBe("function");
		expect(typeof services.modelRegistry.hasConfiguredAuth).toBe("function");
		expect(typeof services.modelRegistry.getError).toBe("function");
		expect(Array.isArray(services.modelRegistry.getAll())).toBe(true);
		expect(Array.isArray(services.modelRegistry.getAvailable())).toBe(true);
		expect(typeof services.settingsManager.getEnabledModels).toBe("function");
		expect(typeof services.settingsManager.getDefaultProvider).toBe("function");
		expect(typeof services.settingsManager.getDefaultModel).toBe("function");
		expect(typeof services.settingsManager.getDefaultThinkingLevel).toBe("function");
	});
});
