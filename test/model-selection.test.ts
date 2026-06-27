import { describe, expect, it, vi } from "vitest";
import {
	formatModelRef,
	mergeModelSelection,
	persistExplicitSelectionIfNeeded,
	persistThinkingLevelIfNeeded,
	resolveRequestedModelSelection,
	resolveSessionModelSelection,
	splitModelThinking,
} from "../src/model-selection.js";

type TestModel = {
	provider: string;
	id: string;
	name?: string;
};

function model(provider: string, id: string, name = id): TestModel {
	return { provider, id, name };
}

function registry(models: TestModel[], authenticated: Array<string> = models.map(formatModelRef)) {
	const auth = new Set(authenticated);
	return {
		getAll: () => models,
		find: (provider: string, modelId: string) => models.find((item) => item.provider === provider && item.id === modelId),
		hasConfiguredAuth: (item: TestModel) => auth.has(formatModelRef(item)),
	} as unknown as Parameters<typeof resolveRequestedModelSelection>[0];
}

const MODELS = [
	model("openai-codex", "gpt-5.4-mini", "GPT 5.4 Mini"),
	model("openai-codex", "gpt-5.4", "GPT 5.4"),
	model("openrouter", "openai/gpt-5.4-mini", "GPT 5.4 Mini via OpenRouter"),
	model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro"),
	model("openrouter", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro via OpenRouter"),
];

describe("model selection", () => {
	it("resolves canonical provider/model references", () => {
		const resolved = resolveRequestedModelSelection(registry(MODELS), { model: "openai-codex/gpt-5.4-mini" });

		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.4-mini");
		expect(resolved.explicitModel).toBe(true);
		expect(resolved.thinkingLevel).toBeUndefined();
	});

	it("resolves provider-scoped fuzzy references", () => {
		const resolved = resolveRequestedModelSelection(registry(MODELS), {
			provider: "openai-codex",
			model: "mini",
		});

		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.4-mini");
	});

	it("merges pending selections with partial CLI overrides", () => {
		expect(mergeModelSelection(
			{ provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			{ thinkingLevel: "high" },
		)).toEqual({ provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" });

		expect(mergeModelSelection(
			{ provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			{ model: "openai-codex/gpt-5.4" },
		)).toEqual({ provider: undefined, model: "openai-codex/gpt-5.4", thinkingLevel: "low" });

		expect(mergeModelSelection(
			{ provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "low" },
			{ model: "openai-codex/gpt-5.4:high" },
		)).toEqual({ provider: undefined, model: "openai-codex/gpt-5.4:high", thinkingLevel: undefined });
	});

	it("parses model:thinking suffixes", () => {
		expect(splitModelThinking("openai-codex/gpt-5.4-mini:high")).toEqual({
			modelRef: "openai-codex/gpt-5.4-mini",
			thinkingLevel: "high",
		});

		const resolved = resolveRequestedModelSelection(registry(MODELS), {
			model: "openai-codex/gpt-5.4-mini:high",
		});

		expect(resolved.model?.id).toBe("gpt-5.4-mini");
		expect(resolved.thinkingLevel).toBe("high");
		expect(resolved.explicitThinking).toBe(true);
	});

	it("lets explicit --thinking win over model:thinking", () => {
		const resolved = resolveRequestedModelSelection(registry(MODELS), {
			model: "openai-codex/gpt-5.4-mini:high",
			thinkingLevel: "low",
		});

		expect(resolved.model?.id).toBe("gpt-5.4-mini");
		expect(resolved.thinkingLevel).toBe("low");
	});

	it("rejects invalid thinking levels", () => {
		expect(() =>
			resolveRequestedModelSelection(registry(MODELS), {
				thinkingLevel: "turbo" as never,
			}),
		).toThrow('Invalid --thinking "turbo"');
	});

	it("rejects ambiguous fuzzy model references", () => {
		expect(() => resolveRequestedModelSelection(registry(MODELS), { model: "mini" })).toThrow("is ambiguous");
	});

	it("rejects unauthenticated selected models", () => {
		expect(() =>
			resolveRequestedModelSelection(registry(MODELS, ["openai-codex/gpt-5.4"]), {
				model: "openai-codex/gpt-5.4-mini",
			}),
		).toThrow("No API key/auth configured for openai-codex/gpt-5.4-mini");
	});

	it("does not restore synthetic off thinking without a persisted thinking entry", () => {
		const resolved = resolveSessionModelSelection(
			registry(MODELS),
			{ messages: [], model: null, thinkingLevel: "off", hasThinkingEntry: false },
			undefined,
		);

		expect(resolved.thinkingLevel).toBeUndefined();
	});

	it("restores persisted thinking entries", () => {
		const resolved = resolveSessionModelSelection(
			registry(MODELS),
			{ messages: [{ role: "user" }], model: null, thinkingLevel: "high", hasThinkingEntry: true },
			undefined,
		);

		expect(resolved.thinkingLevel).toBe("high");
	});

	it("restores persisted models only when auth is configured", () => {
		const authenticated = resolveSessionModelSelection(
			registry(MODELS),
			{
				messages: [{ role: "user" }],
				model: { provider: "openai-codex", modelId: "gpt-5.4-mini" },
				thinkingLevel: "off",
				hasThinkingEntry: false,
			},
			undefined,
		);
		expect(authenticated.model?.provider).toBe("openai-codex");
		expect(authenticated.model?.id).toBe("gpt-5.4-mini");

		const unauthenticated = resolveSessionModelSelection(
			registry(MODELS, []),
			{
				messages: [{ role: "user" }],
				model: { provider: "openai-codex", modelId: "gpt-5.4-mini" },
				thinkingLevel: "off",
				hasThinkingEntry: false,
			},
			undefined,
		);
		expect(unauthenticated.model).toBeUndefined();
	});

	it("persists thinking when live state already matches but history does not", () => {
		const appendThinkingLevelChange = vi.fn();
		const setThinkingLevel = vi.fn();
		const session = {
			thinkingLevel: "high",
			setThinkingLevel,
			sessionManager: {
				buildSessionContext: () => ({ thinkingLevel: "off" }),
				appendThinkingLevelChange,
			},
		} as never;

		persistThinkingLevelIfNeeded(session, "high");

		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(appendThinkingLevelChange).toHaveBeenCalledWith("high");
	});

	it("persists explicit model and thinking changes for materialized sessions", async () => {
		const setModel = vi.fn(async () => undefined);
		const appendThinkingLevelChange = vi.fn();
		const session = {
			thinkingLevel: "high",
			setModel,
			setThinkingLevel: vi.fn(),
			sessionManager: {
				buildSessionContext: () => ({ thinkingLevel: "off" }),
				appendThinkingLevelChange,
			},
		} as never;
		const nextModel = model("openai-codex", "gpt-5.4-mini");

		await persistExplicitSelectionIfNeeded(
			session,
			{
				messages: [{ role: "user" }],
				model: { provider: "openai-codex", modelId: "gpt-5.4" },
				thinkingLevel: "off",
				hasThinkingEntry: true,
			},
			{
				model: nextModel as never,
				thinkingLevel: "high",
				explicitModel: true,
				explicitThinking: true,
			},
		);

		expect(setModel).toHaveBeenCalledWith(nextModel);
		expect(appendThinkingLevelChange).toHaveBeenCalledWith("high");
	});
});
