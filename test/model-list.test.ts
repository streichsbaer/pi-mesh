import { afterEach, describe, expect, it, vi } from "vitest";
import { listModelsFromServices, printModelList, type ModelListServices } from "../src/model-list.js";

type TestModel = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
};

function model(provider: string, id: string, options: Partial<TestModel> = {}): TestModel {
	return {
		provider,
		id,
		name: options.name ?? id,
		reasoning: options.reasoning ?? true,
		input: options.input ?? ["text"],
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: options.maxTokens ?? 8192,
	};
}

const allModels = [
	model("openai-codex", "gpt-5.4-mini", { name: "GPT 5.4 Mini", reasoning: false }),
	model("openai-codex", "gpt-5.4", { name: "GPT 5.4", reasoning: true }),
	model("deepseek", "deepseek-v4-pro", { name: "DeepSeek V4 Pro" }),
	model("openrouter", "deepseek/deepseek-v4-pro", { name: "DeepSeek V4 Pro via OpenRouter" }),
	model("google", "gemini-3.5-flash", { name: "Gemini 3.5 Flash", input: ["text", "image"] }),
	model("openrouter", "google/gemini-3.5-flash", { name: "Gemini 3.5 Flash via OpenRouter" }),
	model("anthropic", "claude-sonnet-4-5", { name: "Claude Sonnet 4.5" }),
];

function services(options: {
	availableRefs?: string[];
	enabledModels?: string[];
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	loadError?: string;
} = {}): ModelListServices {
	const availableRefs = new Set(options.availableRefs ?? [
		"openai-codex/gpt-5.4-mini",
		"deepseek/deepseek-v4-pro",
		"google/gemini-3.5-flash",
		"anthropic/claude-sonnet-4-5",
	]);
	const availableModels = allModels.filter((item) => availableRefs.has(`${item.provider}/${item.id}`));
	return {
		cwd: "/tmp/pi-mesh-test",
		diagnostics: [],
		modelRegistry: {
			getAll: () => allModels,
			getAvailable: () => availableModels,
			getError: () => options.loadError,
		},
		settingsManager: {
			getEnabledModels: () => options.enabledModels ?? [],
			getDefaultProvider: () => options.defaultProvider,
			getDefaultModel: () => options.defaultModel,
			getDefaultThinkingLevel: () => options.defaultThinkingLevel,
		},
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("model list", () => {
	it("lists only available models by default", () => {
		const result = listModelsFromServices(services(), { cwd: "/tmp/pi-mesh-test" });

		expect(result.models.map((item) => item.ref)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"deepseek/deepseek-v4-pro",
			"google/gemini-3.5-flash",
			"openai-codex/gpt-5.4-mini",
		]);
		expect(result.models.every((item) => item.available)).toBe(true);
	});

	it("includes unavailable known models with --all", () => {
		const result = listModelsFromServices(services(), { cwd: "/tmp/pi-mesh-test", includeAll: true });

		expect(result.models.map((item) => item.ref)).toContain("openrouter/deepseek/deepseek-v4-pro");
		expect(result.models.find((item) => item.ref === "openrouter/deepseek/deepseek-v4-pro")?.available).toBe(false);
	});

	it("marks canonical scoped exact matches before slash-containing model ids", () => {
		const result = listModelsFromServices(
			services({
				enabledModels: ["deepseek/deepseek-v4-pro", "google/gemini-3.5-flash"],
			}),
			{ cwd: "/tmp/pi-mesh-test", includeAll: true },
		);

		expect(result.models.find((item) => item.ref === "deepseek/deepseek-v4-pro")?.scoped).toBe(true);
		expect(result.models.find((item) => item.ref === "openrouter/deepseek/deepseek-v4-pro")?.scoped).toBe(false);
		expect(result.models.find((item) => item.ref === "google/gemini-3.5-flash")?.scoped).toBe(true);
		expect(result.models.find((item) => item.ref === "openrouter/google/gemini-3.5-flash")?.scoped).toBe(false);
	});

	it("resolves scoped patterns against available models", () => {
		const result = listModelsFromServices(
			services({
				availableRefs: ["openai-codex/gpt-5.4-mini"],
				enabledModels: ["deepseek/deepseek-v4-pro"],
			}),
			{ cwd: "/tmp/pi-mesh-test", includeAll: true },
		);

		expect(result.models.find((item) => item.ref === "deepseek/deepseek-v4-pro")?.available).toBe(false);
		expect(result.models.find((item) => item.ref === "deepseek/deepseek-v4-pro")?.scoped).toBe(false);
	});

	it("supports --scoped filtering, glob patterns, and thinking suffixes", () => {
		const result = listModelsFromServices(
			services({ enabledModels: ["anthropic/*sonnet*:high", "openai-codex/gpt-5.4-mini"] }),
			{ cwd: "/tmp/pi-mesh-test", scopedOnly: true },
		);

		expect(result.models.map((item) => item.ref)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai-codex/gpt-5.4-mini",
		]);
		expect(result.scopedResolution.approximate).toBe(true);
		expect(result.scopedResolution.note).toContain("approximates enabledModels");
	});

	it("filters search text and reports defaults and diagnostics", () => {
		const result = listModelsFromServices(
			services({
				defaultProvider: "openai-codex",
				defaultModel: "gpt-5.4-mini",
				defaultThinkingLevel: "low",
				loadError: "bad models.json",
			}),
			{ cwd: "/tmp/pi-mesh-test", search: "5.4-mini" },
		);

		expect(result.models.map((item) => item.ref)).toEqual(["openai-codex/gpt-5.4-mini"]);
		expect(result.models[0].default).toBe(true);
		expect(result.defaultModel).toEqual({ provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" });
		expect(result.diagnostics).toContainEqual({ type: "warning", message: "errors loading models.json: bad models.json" });
	});

	it("prints the approximation note only for scoped text output", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const result = listModelsFromServices(
			services({ enabledModels: ["openai-codex/gpt-5.4-mini"] }),
			{ cwd: "/tmp/pi-mesh-test" },
		);

		printModelList(result);
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining("approximates enabledModels"));

		printModelList({ ...result, scopedOnly: true });
		expect(error).toHaveBeenCalledWith(expect.stringContaining("approximates enabledModels"));
		expect(log).toHaveBeenCalled();
	});
});
