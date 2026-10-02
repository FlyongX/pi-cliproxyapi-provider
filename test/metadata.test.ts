import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodexClientModel,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	fetchModelsDevCostMap,
	matchModelCost,
	toPiModel,
	ZERO_COST,
} from "../extensions/lib.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-metadata-test-"));
	tempDirs.push(dir);
	return dir;
}

async function referenceCatalog(providers: Record<string, unknown>, agentDir = tempAgentDir()) {
	const response = new Response("{}", { status: 200 });
	vi.spyOn(response, "json").mockResolvedValue(providers);
	vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
	return fetchModelsDevCostMap(agentDir);
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("models.dev model metadata", () => {
	it("keeps fetched metadata usable when writing the raw directory cache fails", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "cache"), "not a directory");
		const catalog = await referenceCatalog(
			{
				openai: { models: { "gpt-5.4": { limit: { context: 1000000, output: 64000 } } } },
			},
			agentDir,
		);
		expect(toPiModel({ slug: "gpt-5.4" }, catalog)).toMatchObject({ contextWindow: 1000000, maxTokens: 64000 });
	});

	it("replaces CPA reasoning with off-only support when none is the sole declared effort", async () => {
		const catalog = await referenceCatalog({
			openai: { models: { "gpt-5.4": { reasoning_options: [{ type: "effort", values: ["none"] }] } } },
		});
		expect(toPiModel({ slug: "gpt-5.4", supported_reasoning_levels: ["high"] }, catalog)).toMatchObject({
			reasoning: false,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
				ultra: null,
			},
		});
	});

	it.each([
		undefined,
		null,
		"1000000",
		0,
		-1,
		Number.POSITIVE_INFINITY,
		Number.NaN,
		{},
		true,
	])("falls back independently for invalid reference limits: %s", async (invalid) => {
		const catalog = await referenceCatalog({
			openai: {
				models: {
					"gpt-context": { limit: { context: invalid, output: 64000 } },
					"gpt-output": { limit: { context: 1000000, output: invalid } },
				},
			},
		});
		expect(toPiModel({ slug: "gpt-context", context_window: 32000, max_tokens: 4096 }, catalog)).toMatchObject({
			contextWindow: 32000,
			maxTokens: 64000,
		});
		expect(toPiModel({ slug: "gpt-output", context_window: 32000, max_tokens: 4096 }, catalog)).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 4096,
		});
	});

	it("preserves CPA fallback order and defaults, rejecting malformed and non-finite CPA limits", async () => {
		const catalog = await referenceCatalog({ openai: { models: {} } });
		for (const invalid of [undefined, null, "1000000", 0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
			const cpa = {
				slug: "unknown",
				context_window: invalid,
				max_context_window: 64000,
				max_tokens: invalid,
				max_output_tokens: 8192,
				max_completion_tokens: 4096,
			} as unknown as CodexClientModel;
			expect(toPiModel(cpa, catalog)).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
			expect(toPiModel({ ...cpa, max_context_window: 0, max_output_tokens: 0 }, catalog)).toMatchObject({
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: 4096,
			});
		}
		expect(toPiModel({ slug: "unknown" }, catalog)).toMatchObject({
			contextWindow: 128000,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	});

	it.each([
		"context",
		"output",
		"reasoning",
	])("does not use equal reseller prices to resolve conflicting %s metadata", async (conflict) => {
		const first = {
			cost: { input: 1, output: 2 },
			limit: { context: 1000000, output: 64000 },
			reasoning_options: [{ type: "effort", values: ["low"] }],
		};
		const second =
			conflict === "context"
				? { ...first, limit: { context: 200000, output: 64000 } }
				: conflict === "output"
					? { ...first, limit: { context: 1000000, output: 8192 } }
					: { ...first, reasoning_options: [{ type: "effort", values: ["high"] }] };
		const catalog = await referenceCatalog({
			resellerA: { models: { "gpt-5.4": first } },
			resellerB: { models: { "gpt-5.4": second } },
		});
		expect(matchModelCost("gpt-5.4", catalog)).toMatchObject({ input: 1, output: 2 });
		expect(
			toPiModel(
				{ slug: "gpt-5.4", context_window: 32000, max_tokens: 4096, supported_reasoning_levels: ["medium"] },
				catalog,
			),
		).toMatchObject({
			contextWindow: 32000,
			maxTokens: 4096,
			thinkingLevelMap: { low: null, medium: "medium", high: null },
		});
	});

	it("accepts unambiguous reseller metadata even when prices differ", async () => {
		const catalog = await referenceCatalog({
			resellerA: {
				models: { "custom-model": { cost: { input: 1, output: 2 }, limit: { context: 1000000, output: 64000 } } },
			},
			resellerB: {
				models: { "custom-model": { cost: { input: 3, output: 4 }, limit: { context: 1000000, output: 64000 } } },
			},
		});
		expect(toPiModel({ slug: "custom-model" }, catalog)).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 64000,
			cost: ZERO_COST,
		});
	});

	it("rejects normalization collisions and inconsistent explicit provider namespaces", async () => {
		const reference = { limit: { context: 1000000, output: 64000 } };
		const catalog = await referenceCatalog({
			anthropic: { models: { "claude-sonnet-4.6": reference, "claude-sonnet-4_6": reference, custom: reference } },
			reseller: { models: { "anthropic/gpt-5.4": reference } },
			openai: { models: { "gpt-54": reference } },
		});
		for (const slug of ["claude-sonnet-4-6", "gpt-5.4", "openai/custom"]) {
			expect(toPiModel({ slug, context_window: 32000, max_tokens: 4096 }, catalog)).toMatchObject({
				contextWindow: 32000,
				maxTokens: 4096,
			});
		}
	});

	it("does not borrow metadata from price aliases or strip unknown variant suffixes", async () => {
		const reference = {
			cost: { input: 2, output: 12 },
			limit: { context: 1000000, output: 64000 },
			reasoning: false,
		};
		const catalog = await referenceCatalog({
			google: {
				models: {
					"gemini-3.1-pro-preview": reference,
					"gemini-3.6-flash": reference,
					"gemini-3.5-flash": reference,
				},
			},
			openai: { models: { "gpt-5.4": reference } },
		});
		expect(matchModelCost("gemini-pro-agent", catalog)).toMatchObject({ input: 2, output: 12 });
		for (const slug of [
			"gemini-pro-agent",
			"gemini-3.1-pro-low",
			"gemini-3.6-flash-high",
			"gemini-3-flash-agent",
			"gpt-5.4-high",
			"gpt-5.4-fast",
			"gpt-5.4-pro",
			"gpt-5.4-agent",
		]) {
			expect(
				toPiModel({ slug, context_window: 32000, max_tokens: 4096, supported_reasoning_levels: ["high"] }, catalog),
			).toMatchObject({
				id: slug,
				contextWindow: 32000,
				maxTokens: 4096,
				reasoning: true,
				thinkingLevelMap: { high: "high" },
			});
		}
	});

	it.each([
		undefined,
		[{ type: "budget_tokens", min: 0, max: 32000 }],
		[{ type: "toggle" }],
		[{ type: "effort", values: [null, "default", "off", "unknown", 1] }],
		[{ type: "effort", values: "high" }],
		{ type: "effort", values: ["high"] },
		[null, "high", { type: "effort", values: [] }],
	])("retains CPA reasoning for absent, budget/toggle-only or malformed named efforts: %j", async (options) => {
		const catalog = await referenceCatalog({
			openai: {
				models: {
					"gpt-5.4": { reasoning: true, reasoning_options: options, limit: { context: 1000000, output: 64000 } },
				},
			},
		});
		expect(toPiModel({ slug: "gpt-5.4", supported_reasoning_levels: ["none", "high"] }, catalog)).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 64000,
			reasoning: true,
			thinkingLevelMap: { off: "none", low: null, medium: null, high: "high" },
		});
		expect(toPiModel({ slug: "gpt-5.4" }, catalog)).toMatchObject({ reasoning: false });
	});

	it("does not infer off from toggle, null or default, and adds only explicitly supported named levels", async () => {
		const catalog = await referenceCatalog({
			openai: {
				models: {
					"gpt-5.4": {
						reasoning_options: [
							{ type: "toggle" },
							{ type: "effort", values: [null, "default", "minimal", "low", "xhigh"] },
						],
					},
				},
			},
		});
		expect(
			toPiModel({ slug: "gpt-5.4", supported_reasoning_levels: ["none", "high", "max"] }, catalog),
		).toMatchObject({
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: null,
				high: null,
				xhigh: "xhigh",
				max: null,
				ultra: null,
			},
		});
	});

	it("keeps CPA input modalities and visibility even if reference capabilities differ", async () => {
		const catalog = await referenceCatalog({
			openai: {
				models: {
					"gpt-5.4": { modalities: { input: ["text", "image"] }, limit: { context: 1000000, output: 64000 } },
				},
			},
		});
		expect(toPiModel({ slug: "gpt-5.4", input_modalities: ["text"] }, catalog)?.input).toEqual(["text"]);
		expect(toPiModel({ slug: "gpt-5.4", visibility: "hide" }, catalog)).toBeNull();
	});

	it.each([
		["openai", "gpt-5.4", "openai/gpt-5.4"],
		["anthropic", "claude-sonnet-4-6", "anthropic:claude-sonnet-4.6"],
		["google", "gemini-3.1-pro", "google.gemini-3.1-pro"],
		["deepseek", "deepseek-reasoner", "deepseek-reasoner"],
		["alibaba", "qwen3.5-plus", "Qwen3.5-plus"],
		["alibaba", "alibaba/qwen3.5-plus", "qwen3.5-plus"],
		["openai", "openai/gpt-5.4", "gpt-5.4"],
	])("prefers %s metadata over resellers, including explicit namespaces and formatting", async (provider, id, cpaId) => {
		const catalog = await referenceCatalog({
			reseller: { models: { [id]: { limit: { context: 64000, output: 4096 } } } },
			[provider]: { models: { [id]: { limit: { context: 1000000, output: 64000 } } } },
		});
		expect(toPiModel({ slug: cpaId, display_name: "CPA name" }, catalog)).toMatchObject({
			id: cpaId,
			name: "CPA name",
			contextWindow: 1000000,
			maxTokens: 64000,
		});
	});

	it("replaces CPA thinking levels with explicitly named reference efforts without remapping max or ultra", async () => {
		const catalog = await referenceCatalog({
			openai: {
				models: {
					"gpt-5.4": {
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["none", "medium", "max", "ultra", null, "default"] }],
					},
				},
			},
		});
		expect(
			toPiModel({ slug: "gpt-5.4", supported_reasoning_levels: ["low", "high", "xhigh"] }, catalog),
		).toMatchObject({
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: null,
				medium: "medium",
				high: null,
				xhigh: null,
				max: "max",
				ultra: null,
			},
		});
	});

	it("clears CPA reasoning capabilities when the reference explicitly declares reasoning=false", async () => {
		const catalog = await referenceCatalog({
			openai: {
				models: {
					"gpt-5.4": { reasoning: false, reasoning_options: [{ type: "effort", values: ["none", "high"] }] },
				},
			},
		});
		expect(toPiModel({ slug: "gpt-5.4", supported_reasoning_levels: ["none", "high"] }, catalog)).toMatchObject({
			reasoning: false,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
				ultra: null,
			},
		});
	});

	it("uses original-provider limits without prices to fill missing and correct inaccurate CPA limits", async () => {
		const catalog = await referenceCatalog({
			openai: { models: { "gpt-5.4": { limit: { context: 1050000, output: 128000 } } } },
		});
		for (const cpa of [{ slug: "gpt-5.4" }, { slug: "gpt-5.4", context_window: 128000, max_tokens: 16384 }]) {
			expect(toPiModel(cpa, catalog)).toMatchObject({ contextWindow: 1050000, maxTokens: 128000 });
		}
	});
});
