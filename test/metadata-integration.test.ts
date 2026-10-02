import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import providerExtension, { registerRefreshCommand } from "../extensions/index.ts";
import {
	loadModelsCache,
	MODELS_DEV_CACHE_TTL_MS,
	resolveEndpoints,
	saveModelsCache,
	toPiModel,
} from "../extensions/lib.ts";

let agentDir: string;
const shutdownHandlers: Array<() => Promise<void>> = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-metadata-integration-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	for (const name of [
		"CLIPROXYAPI_API_KEY",
		"CLIPROXYAPI_BASE_URL",
		"CLIPROXYAPI_FAST",
		"CLIPROXYAPI_PROVIDER_ID",
		"CLIPROXYAPI_PROVIDER_NAME",
	])
		vi.stubEnv(name, undefined);
	writeFileSync(
		join(agentDir, "cliproxyapi.json"),
		JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "test-key" }),
	);
});

afterEach(async () => {
	for (const shutdown of shutdownHandlers.splice(0)) await shutdown();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

function referenceProviders(context: number) {
	return {
		openai: {
			models: {
				"gpt-5.4": {
					limit: { context, output: 128000 },
					reasoning: true,
					reasoning_options: [{ type: "effort", values: ["low", "high"] }],
					cost: { input: 5, output: 30 },
					experimental: { modes: { fast: { cost: { input: 10, output: 60 } } } },
				},
			},
		},
	};
}

function seedReferenceCache(context = 200000, timestamp = Date.now()): void {
	mkdirSync(join(agentDir, "cache", "cliproxyapi"), { recursive: true });
	writeFileSync(
		join(agentDir, "cache", "cliproxyapi", "models-dev.json"),
		JSON.stringify({ timestamp, providers: referenceProviders(context) }),
	);
}

function cpaResponse() {
	return new Response(
		JSON.stringify({
			models: [
				{
					slug: "gpt-5.4",
					display_name: "CPA GPT",
					context_window: 128000,
					max_tokens: 4096,
					input_modalities: ["text"],
					supported_reasoning_levels: ["medium", "xhigh"],
					service_tiers: [{ id: "priority" }],
				},
			],
		}),
		{ status: 200 },
	);
}

function mockCatalogRequests(referenceContext = 1050000) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (String(input) === "https://models.dev/api.json") {
			return new Response(JSON.stringify(referenceProviders(referenceContext)), { status: 200 });
		}
		return cpaResponse();
	});
}

async function createHost() {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "catalog-cache.json"),
		refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const events = new Map<string, Array<(...args: any[]) => unknown>>();
	const pi = {
		registerProvider: vi.fn((id: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) =>
			registry.registerProvider(id, config),
		),
		unregisterProvider: vi.fn((id: string) => registry.unregisterProvider(id)),
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command),
		on: (name: string, handler: (...args: any[]) => unknown) =>
			events.set(name, [...(events.get(name) ?? []), handler]),
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
	} as unknown as ExtensionAPI;
	shutdownHandlers.push(async () => {
		for (const handler of events.get("session_shutdown") ?? []) await handler({}, {});
	});
	return { pi, registry, commands };
}

describe("registered model metadata and reference refresh", () => {
	it("manual refresh both corrects reference metadata and strictly removes missing CPA models and Fast IDs", async () => {
		seedReferenceCache();
		saveModelsCache(agentDir, {
			...resolveEndpoints("http://127.0.0.1:8317"),
			models: [toPiModel({ slug: "gpt-5.4" })!, toPiModel({ slug: "removed" })!],
			fastModelIds: ["gpt-5.4", "removed"],
			fastMode: false,
		});
		mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		await vi.waitFor(() => expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(200000));
		expect(registry.find("cliproxyapi", "removed")).toBeDefined();

		await commands
			.get("cliproxyapi-refresh")!
			.handler("", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);

		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(1050000);
		expect(registry.find("cliproxyapi", "removed")).toBeUndefined();
		const cache = loadModelsCache(agentDir, "http://127.0.0.1:8317")!;
		expect(cache.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
		expect(cache.fastModelIds).toEqual(["gpt-5.4"]);
	});

	it("a valid empty CPA catalog still clears registration when the forced reference refresh fails", async () => {
		seedReferenceCache();
		const fetchMock = mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(200000);
		fetchMock.mockImplementation(async (input) => {
			if (String(input) === "https://models.dev/api.json") throw new Error("offline");
			return Response.json({ models: [] });
		});
		const notify = vi.fn();

		await commands.get("cliproxyapi-refresh")!.handler("", { ui: { notify } } as unknown as ExtensionCommandContext);

		expect(registry.find("cliproxyapi", "gpt-5.4")).toBeUndefined();
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317")).toMatchObject({ models: [], fastModelIds: [] });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 0"), "info");
	});

	it.each([
		"startup",
		"background",
		"login",
		"fast",
	])("%s uses a fresh reference cache rather than forcing a directory download", async (path) => {
		seedReferenceCache();
		if (path === "background") {
			const { inferenceBaseUrl, modelsUrl } = resolveEndpoints("http://127.0.0.1:8317");
			saveModelsCache(agentDir, {
				inferenceBaseUrl,
				modelsUrl,
				models: [toPiModel({ slug: "gpt-5.4" })!],
				fastModelIds: ["gpt-5.4"],
				fastMode: false,
			});
		}
		const fetchMock = mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		await vi.waitFor(() => expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(200000));
		if (path === "login") {
			await registry.getRegisteredProviderConfig("cliproxyapi")!.oauth!.login({
				onAuth: vi.fn(),
				onDeviceCode: vi.fn(),
				onSelect: async () => undefined,
				onPrompt: async ({ message }) => (message.includes("URL") ? "http://127.0.0.1:8317" : "test-key"),
			});
		} else if (path === "fast") {
			await commands.get("fast")!.handler("", {
				model: registry.find("cliproxyapi", "gpt-5.4"),
				modelRegistry: registry,
				ui: { notify: vi.fn() },
			} as unknown as ExtensionCommandContext);
			expect(registry.find("cliproxyapi", "gpt-5.4")?.cost.input).toBe(10);
		}
		const model = registry.find("cliproxyapi", "gpt-5.4")!;
		expect(model.contextWindow).toBe(200000);
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "high"]);
		expect(fetchMock.mock.calls.filter(([url]) => String(url) === "https://models.dev/api.json")).toHaveLength(0);
		expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/models"))).toHaveLength(
			path === "login" || path === "fast" ? 2 : 1,
		);
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("ordinary startup refreshes an expired reference cache and reuses the new directory on Fast changes", async () => {
		seedReferenceCache(200000, Date.now() - MODELS_DEV_CACHE_TTL_MS - 1);
		const fetchMock = mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(1050000);
		await commands.get("fast")!.handler("", {
			model: registry.find("cliproxyapi", "gpt-5.4"),
			modelRegistry: registry,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext);
		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(1050000);
		expect(fetchMock.mock.calls.filter(([url]) => String(url) === "https://models.dev/api.json")).toHaveLength(1);
	});

	it.each([
		"network",
		"http",
		"json",
		"invalid",
	])("manual reference refresh failure (%s) retains old metadata without blocking CPA registration", async (failure) => {
		seedReferenceCache();
		const fetchMock = mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		fetchMock.mockImplementation(async (input) => {
			if (String(input) !== "https://models.dev/api.json") return cpaResponse();
			if (failure === "network") throw new Error("offline");
			if (failure === "http") return new Response("unavailable", { status: 503 });
			return new Response(failure === "json" ? "not json" : "{}", { status: 200 });
		});
		const notify = vi.fn();
		await commands.get("cliproxyapi-refresh")!.handler("", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(registry.find("cliproxyapi", "gpt-5.4")).toMatchObject({ contextWindow: 200000, maxTokens: 128000 });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1"), "info");
	});

	it("retains reference metadata after the existing three-second download timeout", async () => {
		seedReferenceCache();
		const fetchMock = mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		vi.useFakeTimers();
		fetchMock.mockImplementation(async (input, init) => {
			if (String(input) !== "https://models.dev/api.json") return cpaResponse();
			return new Promise<Response>((_resolve, reject) => {
				init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
			});
		});
		const notify = vi.fn();
		const refresh = commands
			.get("cliproxyapi-refresh")!
			.handler("", { ui: { notify } } as unknown as ExtensionCommandContext);
		await vi.advanceTimersByTimeAsync(3000);
		await refresh;
		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(200000);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1"), "info");
	});

	it("registers CPA fallback metadata when the reference service fails without an old directory", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === "https://models.dev/api.json") throw new Error("offline");
			return cpaResponse();
		});
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		await commands
			.get("cliproxyapi-refresh")!
			.handler("", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);
		const model = registry.find("cliproxyapi", "gpt-5.4")!;
		expect(model).toMatchObject({ contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0 } });
		expect(getSupportedThinkingLevels(model)).toEqual(["medium", "xhigh"]);
	});

	it("keeps host modelOverrides above reference metadata across startup and manual refresh", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					cliproxyapi: {
						modelOverrides: {
							"gpt-5.4": {
								contextWindow: 32768,
								maxTokens: 2048,
								thinkingLevelMap: { low: null, high: null, xhigh: "xhigh" },
							},
						},
					},
				},
			}),
		);
		seedReferenceCache();
		mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		const before = registry.find("cliproxyapi", "gpt-5.4")!;
		expect(before).toMatchObject({ contextWindow: 32768, maxTokens: 2048 });
		expect(getSupportedThinkingLevels(before)).toEqual(["xhigh"]);
		await commands
			.get("cliproxyapi-refresh")!
			.handler("", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);
		const after = registry.find("cliproxyapi", "gpt-5.4")!;
		expect(after).toMatchObject({ contextWindow: 32768, maxTokens: 2048 });
		expect(getSupportedThinkingLevels(after)).toEqual(["xhigh"]);
	});

	it("also forces reference refresh when the refresh command is registered without a coordinator callback", async () => {
		seedReferenceCache();
		mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		registerRefreshCommand({
			pi,
			agentDir,
			providerId: "cliproxyapi",
			providerName: "CLIProxyAPI",
			defaultBaseUrl: "http://127.0.0.1:8317",
			streamSimple: () => {
				throw new Error("not used");
			},
			fastMode: new FastModeController(false),
		});
		await commands
			.get("cliproxyapi-refresh")!
			.handler("", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);
		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(1050000);
	});

	it("manual refresh bypasses a fresh reference cache and publishes new limits and selectable efforts", async () => {
		seedReferenceCache();
		const fetchMock = mockCatalogRequests();
		const { pi, registry, commands } = await createHost();
		await providerExtension(pi);
		expect(registry.find("cliproxyapi", "gpt-5.4")?.contextWindow).toBe(200000);
		const updatedReference = referenceProviders(1050000);
		updatedReference.openai.models["gpt-5.4"].reasoning_options[0]!.values = ["none", "medium", "max"];
		fetchMock.mockImplementation(async (input) =>
			String(input) === "https://models.dev/api.json"
				? new Response(JSON.stringify(updatedReference), { status: 200 })
				: cpaResponse(),
		);

		const notify = vi.fn();
		await commands.get("cliproxyapi-refresh")!.handler("", { ui: { notify } } as unknown as ExtensionCommandContext);

		const model = registry.find("cliproxyapi", "gpt-5.4")!;
		expect(model).toMatchObject({
			id: "gpt-5.4",
			name: "CPA GPT",
			provider: "cliproxyapi",
			api: "cliproxyapi-codex-responses",
			baseUrl: "http://127.0.0.1:8317/backend-api/",
			contextWindow: 1050000,
			maxTokens: 128000,
			input: ["text"],
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "medium", "max"]);
		expect(fetchMock.mock.calls.filter(([url]) => String(url) === "https://models.dev/api.json")).toHaveLength(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1"), "info");
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
	});
});
