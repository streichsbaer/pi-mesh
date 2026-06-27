import { createAgentSessionServices, type AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

type PiModel = ReturnType<AgentSessionServices["modelRegistry"]["getAll"]>[number];

export type ModelListServices = Pick<AgentSessionServices, "cwd" | "diagnostics" | "modelRegistry" | "settingsManager">;

export interface ListModelsOptions {
	cwd: string;
	search?: string;
	includeAll?: boolean;
	scopedOnly?: boolean;
}

export interface ListedModel {
	provider: string;
	model: string;
	ref: string;
	name?: string;
	available: boolean;
	scoped: boolean;
	matchedScopedPatterns: string[];
	default: boolean;
	contextWindow: number;
	maxTokens: number;
	thinking: boolean;
	images: boolean;
}

export interface ModelListResult {
	ok: true;
	folder: string;
	search?: string;
	includeAll: boolean;
	scopedOnly: boolean;
	enabledModelPatterns: string[];
	defaultModel?: {
		provider?: string;
		model?: string;
		thinkingLevel?: ThinkingLevel;
	};
	scopedResolution: {
		approximate: boolean;
		note?: string;
	};
	diagnostics: Array<{ type: string; message: string }>;
	models: ListedModel[];
}

const SCOPED_RESOLUTION_NOTE = "Pi does not currently export stable public helpers for CLI-equivalent model or scoped-model resolution; pi-mesh approximates enabledModels matching against Pi available models.";

function formatModelRef(model: PiModel): string {
	return `${model.provider}/${model.id}`;
}

function modelKey(model: Pick<ListedModel, "provider" | "model">): string {
	return `${model.provider}\0${model.model}`;
}

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function stripThinkingSuffix(pattern: string): string {
	const colonIndex = pattern.lastIndexOf(":");
	if (colonIndex <= 0) return pattern;
	return isThinkingLevel(pattern.slice(colonIndex + 1)) ? pattern.slice(0, colonIndex) : pattern;
}

function hasGlob(pattern: string): boolean {
	return /[*?[]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (const char of pattern) {
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${source}$`, "i");
}

function isDatedModelId(id: string): boolean {
	return /\d{4}[-_]\d{2}[-_]\d{2}|\d{8}/.test(id);
}

function chooseBestModel(matches: PiModel[]): PiModel | undefined {
	if (matches.length === 0) return undefined;
	const aliases = matches.filter((model) => !isDatedModelId(model.id));
	const candidates = aliases.length ? aliases : matches;
	return [...candidates].sort((a, b) => b.id.localeCompare(a.id))[0];
}

function findExactScopedModelReferenceMatch(pattern: string, models: PiModel[]): PiModel | undefined {
	const lower = pattern.toLowerCase();
	const canonicalMatches = models.filter((model) => formatModelRef(model).toLowerCase() === lower);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;

	const slashIndex = pattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = pattern.slice(0, slashIndex).trim().toLowerCase();
		const modelId = pattern.slice(slashIndex + 1).trim().toLowerCase();
		if (provider && modelId) {
			const providerMatches = models.filter((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId);
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}

	const idMatches = models.filter((model) => model.id.toLowerCase() === lower);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function resolveScopedPattern(rawPattern: string, models: PiModel[]): PiModel[] {
	const pattern = stripThinkingSuffix(rawPattern.trim());
	if (!pattern) return [];
	if (hasGlob(pattern)) {
		const regex = globToRegExp(pattern);
		return models.filter((model) => regex.test(formatModelRef(model)) || regex.test(model.id));
	}

	const exact = findExactScopedModelReferenceMatch(pattern, models);
	if (exact) return [exact];

	const lower = pattern.toLowerCase();
	const partial = models.filter((model) => model.id.toLowerCase().includes(lower) || Boolean(model.name?.toLowerCase().includes(lower)));
	return [chooseBestModel(partial)].filter((model): model is PiModel => Boolean(model));
}

function matchesSearch(model: ListedModel, search: string | undefined): boolean {
	if (!search) return true;
	const lower = search.toLowerCase();
	return [model.provider, model.model, model.ref, model.name]
		.filter(Boolean)
		.some((value) => String(value).toLowerCase().includes(lower));
}

export function listModelsFromServices(services: ModelListServices, options: ListModelsOptions): ModelListResult {
	const allModels = services.modelRegistry.getAll();
	const availableModels = services.modelRegistry.getAvailable();
	const availableKeys = new Set(availableModels.map((model) => modelKey({ provider: model.provider, model: model.id })));
	const enabledModelPatterns = services.settingsManager.getEnabledModels() ?? [];
	const defaultProvider = services.settingsManager.getDefaultProvider();
	const defaultModel = services.settingsManager.getDefaultModel();
	const defaultThinkingLevel = services.settingsManager.getDefaultThinkingLevel();
	const scopedMatches = new Map<string, string[]>();

	for (const pattern of enabledModelPatterns) {
		for (const model of resolveScopedPattern(pattern, availableModels)) {
			const key = modelKey({ provider: model.provider, model: model.id });
			scopedMatches.set(key, [...(scopedMatches.get(key) ?? []), pattern]);
		}
	}

	const sourceModels = options.includeAll ? allModels : availableModels;
	const rows = sourceModels
		.map<ListedModel>((model) => {
			const key = modelKey({ provider: model.provider, model: model.id });
			const matchedScopedPatterns = scopedMatches.get(key) ?? [];
			return {
				provider: model.provider,
				model: model.id,
				ref: formatModelRef(model),
				name: model.name,
				available: availableKeys.has(key),
				scoped: matchedScopedPatterns.length > 0,
				matchedScopedPatterns,
				default: model.provider === defaultProvider && model.id === defaultModel,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinking: Boolean(model.reasoning),
				images: model.input.includes("image"),
			};
		})
		.filter((model) => !options.scopedOnly || model.scoped)
		.filter((model) => matchesSearch(model, options.search))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

	const diagnostics = [...services.diagnostics];
	const loadError = services.modelRegistry.getError();
	if (loadError) diagnostics.push({ type: "warning", message: `errors loading models.json: ${loadError}` });
	if (options.scopedOnly && enabledModelPatterns.length === 0) {
		diagnostics.push({ type: "info", message: "No Pi enabledModels patterns are configured for this folder." });
	}

	return {
		ok: true,
		folder: services.cwd,
		search: options.search,
		includeAll: Boolean(options.includeAll),
		scopedOnly: Boolean(options.scopedOnly),
		enabledModelPatterns,
		defaultModel: defaultProvider || defaultModel || defaultThinkingLevel
			? { provider: defaultProvider, model: defaultModel, thinkingLevel: defaultThinkingLevel }
			: undefined,
		scopedResolution: {
			approximate: enabledModelPatterns.length > 0,
			note: enabledModelPatterns.length > 0 ? SCOPED_RESOLUTION_NOTE : undefined,
		},
		diagnostics,
		models: rows,
	};
}

export async function listModels(options: ListModelsOptions): Promise<ModelListResult> {
	return listModelsFromServices(await createAgentSessionServices({ cwd: options.cwd }), options);
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return String(count);
}

function pad(value: string, width: number): string {
	return value.padEnd(width);
}

export function printModelList(result: ModelListResult): void {
	for (const diagnostic of result.diagnostics) {
		const prefix = diagnostic.type === "error" ? "Error" : diagnostic.type === "warning" ? "Warning" : "Info";
		console.error(`${prefix}: ${diagnostic.message}`);
	}
	if (result.scopedOnly && result.scopedResolution.note) console.error(`Note: ${result.scopedResolution.note}`);
	if (!result.models.length) {
		console.log(result.search ? `No models matching ${JSON.stringify(result.search)}` : "No models found");
		return;
	}

	const rows = result.models.map((model) => ({
		provider: model.provider,
		model: model.model,
		available: model.available ? "yes" : "no",
		scoped: model.scoped ? "yes" : "no",
		default: model.default ? "yes" : "no",
		context: formatTokenCount(model.contextWindow),
		maxOut: formatTokenCount(model.maxTokens),
		thinking: model.thinking ? "yes" : "no",
		images: model.images ? "yes" : "no",
	}));
	const headers = {
		provider: "provider",
		model: "model",
		available: "auth",
		scoped: "scoped",
		default: "default",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};
	type Column = keyof typeof headers;
	const order = Object.keys(headers) as Column[];
	const widths = Object.fromEntries(
		order.map((key) => [key, Math.max(headers[key].length, ...rows.map((row) => row[key].length))]),
	) as Record<Column, number>;
	const formatRow = (row: Record<Column, string>) => order.map((key) => pad(row[key], widths[key])).join("  ");

	console.log(formatRow(headers));
	for (const row of rows) console.log(formatRow(row));
}
