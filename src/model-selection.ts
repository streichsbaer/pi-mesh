import type { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ModelSelection, type ThinkingLevel } from "./types.js";

type AgentSessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ModelRegistry = AgentSessionInstance["modelRegistry"];
type PiModel = ReturnType<ModelRegistry["getAll"]>[number];

export interface SessionContextSnapshot {
	messages: unknown[];
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	hasThinkingEntry: boolean;
}

export interface ResolvedModelSelection {
	model?: PiModel;
	thinkingLevel?: ThinkingLevel;
	explicitModel: boolean;
	explicitThinking: boolean;
}

export function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function hasModelSelection(selection: ModelSelection | undefined): selection is ModelSelection {
	return Boolean(selection?.provider || selection?.model || selection?.thinkingLevel);
}

export function formatModelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function modelMatches(model: { provider: string; id: string } | undefined, other: { provider: string; id: string }): boolean {
	return model?.provider === other.provider && model.id === other.id;
}

export function splitModelThinking(modelRef: string): { modelRef: string; thinkingLevel?: ThinkingLevel } {
	const colonIndex = modelRef.lastIndexOf(":");
	if (colonIndex > 0) {
		const suffix = modelRef.slice(colonIndex + 1);
		if (isThinkingLevel(suffix)) return { modelRef: modelRef.slice(0, colonIndex), thinkingLevel: suffix };
	}
	return { modelRef };
}

export function modelRefHasThinkingSuffix(modelRef: string | undefined): boolean {
	return Boolean(modelRef && splitModelThinking(modelRef).thinkingLevel);
}

export function mergeModelSelection(base: ModelSelection | undefined, override: ModelSelection | undefined): ModelSelection | undefined {
	if (!base) return override;
	if (!override) return base;
	if (!override.model && !override.provider) return { ...base, thinkingLevel: override.thinkingLevel ?? base.thinkingLevel };
	return {
		provider: override.provider,
		model: override.model,
		thinkingLevel: override.thinkingLevel ?? (modelRefHasThinkingSuffix(override.model) ? undefined : base.thinkingLevel),
	};
}

function selectUniqueModel(matches: PiModel[], requested: string): PiModel | undefined {
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];
	const examples = matches.slice(0, 8).map(formatModelRef).join(", ");
	const suffix = matches.length > 8 ? `, ... ${matches.length - 8} more` : "";
	throw new Error(`Model ${JSON.stringify(requested)} is ambiguous. Use provider/model. Matches: ${examples}${suffix}`);
}

export function resolveModelRef(modelRegistry: ModelRegistry, requested: string, providerInput: string | undefined): PiModel {
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

export function resolveRequestedModelSelection(modelRegistry: ModelRegistry, selection: ModelSelection | undefined): ResolvedModelSelection {
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

export function getSessionContextSnapshot(sessionManager: SessionManager): SessionContextSnapshot {
	const context = sessionManager.buildSessionContext();
	return {
		messages: context.messages,
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		hasThinkingEntry: sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change"),
	};
}

export function restoreModelFromSession(modelRegistry: ModelRegistry, snapshot: SessionContextSnapshot): PiModel | undefined {
	if (!snapshot.model) return undefined;
	const model = modelRegistry.find(snapshot.model.provider, snapshot.model.modelId);
	return model && modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

export function resolveSessionModelSelection(
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

export function persistThinkingLevelIfNeeded(session: AgentSessionInstance, thinkingLevel: ThinkingLevel): void {
	if (session.thinkingLevel !== thinkingLevel) {
		session.setThinkingLevel(thinkingLevel);
		return;
	}
	if (session.sessionManager.buildSessionContext().thinkingLevel !== thinkingLevel) {
		session.sessionManager.appendThinkingLevelChange(thinkingLevel);
	}
}

export async function persistExplicitSelectionIfNeeded(
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
