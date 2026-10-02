import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import providerExtension, { registerRefreshCommand } from "../extensions/index.ts";
import {
	loadModelsCache,
	MODELS_CACHE_FILE_NAME,
	type PiProviderModel,
	resolveEndpoints,
	saveConfigFile,
	saveModelsCache,
	toPiModel,
} from "../extensions/lib.ts";

const BASE_URL = "http://127.0.0.1:8317";
const ENV_NAMES = [
	"PI_CODING_AGENT_DIR",
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
] as const;

function remoteModel(id: string, fast = true) {
	return { id, service_tiers: fast ? [{ id: "priority" }] : [] };
}

function catalog(models = [remoteModel("A"), remoteModel("B")]): Response {
	return Response.json({ models });
}

async function withRefreshHarness(
	run: (harness: {
		agentDir: string;
		pi: ExtensionAPI;
		refresh: (modelId?: string) => Promise<void>;
		registered: () => PiProviderModel[] | undefined;
		login: () => Promise<unknown>;
		shutdown: () => Promise<void>;
		notify: ReturnType<typeof vi.fn>;
		fetchCatalog: ReturnType<typeof vi.fn<(signal?: AbortSignal | null) => Promise<Response>>>;
	}) => Promise<void>,
	startupModels = [remoteModel("A"), remoteModel("B")],
): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-refresh-test-"));
	const previousEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
	for (const name of ENV_NAMES) delete process.env[name];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	saveConfigFile(agentDir, { baseUrl: BASE_URL, apiKey: "test-key" });
	saveModelsCache(agentDir, {
		...resolveEndpoints(BASE_URL),
		models: [toPiModel(remoteModel("A"))!, toPiModel(remoteModel("B"))!],
		fastModelIds: ["A", "B"],
		fastMode: false,
	});
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const listeners = new Map<string, Array<() => void>>();
	const pi = {
		registerCommand: vi.fn((name, command) => commands.set(name, command)),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		setModel: vi.fn(),
		on: vi.fn((event, handler) => listeners.set(event, [...(listeners.get(event) ?? []), handler])),
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const fetchCatalog = vi.fn<(signal?: AbortSignal | null) => Promise<Response>>(async () => catalog(startupModels));
	const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).includes("models.dev")) return Response.json({});
		return fetchCatalog(init?.signal);
	});
	const registered = (): PiProviderModel[] | undefined =>
		(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1].models;
	let stopped = false;
	const shutdown = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		for (const handler of listeners.get("session_shutdown") ?? []) await handler();
	};

	try {
		await providerExtension(pi);
		await vi.waitFor(() => expect(registered()?.[0].stale).toBe(false));
		await run({
			agentDir,
			pi,
			registered,
			notify,
			fetchCatalog,
			shutdown,
			login: async () => {
				const provider = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
				const answers = [BASE_URL, "test-key"];
				return provider.oauth.login({ onPrompt: async () => answers.shift()!, onProgress: vi.fn() });
			},
			refresh: async (modelId = "B") => {
				await commands.get("cliproxyapi-refresh")!.handler("", {
					model: { id: modelId, provider: "cliproxyapi" },
					ui: { notify },
				} as unknown as ExtensionCommandContext);
			},
		});
	} finally {
		await shutdown();
		fetchMock.mockRestore();
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}

describe("manual CPA catalog synchronization", () => {
	it("does not commit an empty response from a request whose timeout has already cancelled it", async () => {
		await withRefreshHarness(async ({ agentDir, refresh, registered, notify, fetchCatalog }) => {
			const previousModels = registered();
			const previousCache = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
			const timeout = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
			const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout);
			fetchCatalog.mockImplementation(async () => catalog([]));
			try {
				await refresh();
				expect(registered()).toBe(previousModels);
				expect(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")).toBe(previousCache);
				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("Failed to refresh CLIProxyAPI models"),
					"error",
				);
			} finally {
				timeoutMock.mockRestore();
			}
		});
	});

	it("strictly synchronizes the standalone command and its live Fast capability set", async () => {
		await withRefreshHarness(async ({ agentDir, pi, refresh, registered, fetchCatalog }) => {
			const fastMode = new FastModeController(true);
			fastMode.setSupportedModelIds(["A", "B", "unregistered"]);
			const provider = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
			registerRefreshCommand({
				pi,
				agentDir,
				providerId: "cliproxyapi",
				providerName: "CLIProxyAPI",
				defaultBaseUrl: BASE_URL,
				streamSimple: provider.streamSimple,
				fastMode,
			});
			fetchCatalog.mockImplementation(async () =>
				Response.json({
					data: [remoteModel("A"), { ...remoteModel("B"), visibility: "hide" }, remoteModel("C", false)],
				}),
			);
			await refresh();
			expect(registered()?.map((model) => model.id)).toEqual(["A", "C"]);
			expect(["A", "B", "C", "unregistered"].map((id) => fastMode.isEffectiveFor(id))).toEqual([
				true,
				false,
				false,
				false,
			]);
			expect(loadModelsCache(agentDir, BASE_URL)?.fastModelIds).toEqual(["A"]);

			fetchCatalog.mockImplementation(async () => new Response("not JSON"));
			await refresh();
			expect(fastMode.isEffectiveFor("A")).toBe(true);
			expect(fastMode.isEffectiveFor("B")).toBe(false);

			fetchCatalog.mockImplementation(async () => catalog([]));
			await refresh();
			expect(registered()).toEqual([]);
			expect(fastMode.isEffectiveFor("A")).toBe(false);
		});
	});

	it("keeps missing B and its Fast capability during background startup refresh", async () => {
		await withRefreshHarness(
			async ({ agentDir, registered }) => {
				expect(registered()?.map((model) => model.id)).toEqual(["A", "B"]);
				expect(registered()?.find((model) => model.id === "B")?.stale).toBe(true);
				const cache = loadModelsCache(agentDir, BASE_URL);
				expect(cache?.models.map((model) => model.id)).toEqual(["A", "B"]);
				expect(cache?.fastModelIds).toEqual(["A", "B"]);
			},
			[remoteModel("A")],
		);
	});

	it.each(["non-JSON", "unknown structure"])("preserves permissive login validation for %s", async (kind) => {
		await withRefreshHarness(async ({ agentDir, login, registered, fetchCatalog }) => {
			fetchCatalog.mockImplementation(async () =>
				kind === "non-JSON" ? new Response("not JSON") : Response.json({}),
			);
			await expect(login()).resolves.toMatchObject({ access: "test-key" });
			expect(registered()?.map((model) => model.id)).toEqual(["A", "B"]);
			expect(loadModelsCache(agentDir, BASE_URL)?.models.every((model) => model.stale)).toBe(true);
		});
	});

	it.each([
		"removed",
		"empty",
	])("ignores a superseded manual refresh that arrives after a newer %s catalog", async (kind) => {
		await withRefreshHarness(async ({ agentDir, refresh, registered, notify, fetchCatalog }) => {
			let releaseOlder!: (response: Response) => void;
			let olderSignal: AbortSignal | null | undefined;
			fetchCatalog.mockImplementationOnce((signal) => {
				olderSignal = signal;
				return new Promise<Response>((resolve) => {
					releaseOlder = resolve;
				});
			});
			const older = refresh();
			await vi.waitFor(() => expect(olderSignal).toBeDefined());
			fetchCatalog.mockImplementation(async () => catalog(kind === "empty" ? [] : [remoteModel("A")]));
			await refresh();
			expect(olderSignal?.aborted).toBe(true);
			const latestCache = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
			const latestModels = registered();

			// The HTTP boundary deliberately ignores cancellation and responds late.
			releaseOlder(catalog([remoteModel("B")]));
			await older;
			expect(registered()).toBe(latestModels);
			expect(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")).toBe(latestCache);
			expect(notify.mock.calls).toHaveLength(1);
		});
	});

	it("ignores a cancelled manual response after session shutdown", async () => {
		await withRefreshHarness(async ({ agentDir, refresh, registered, notify, fetchCatalog, shutdown }) => {
			let release!: (response: Response) => void;
			let signal: AbortSignal | null | undefined;
			fetchCatalog.mockImplementation((requestSignal) => {
				signal = requestSignal;
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			});
			const previousModels = registered();
			const previousCache = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
			const pending = refresh();
			await vi.waitFor(() => expect(signal).toBeDefined());
			await shutdown();
			expect(signal?.aborted).toBe(true);
			release(catalog([]));
			await pending;
			expect(registered()).toBe(previousModels);
			expect(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")).toBe(previousCache);
			expect(notify).not.toHaveBeenCalled();
		});
	});

	it.each([
		null,
		"unexpected",
		{},
		{ error: "capacity unavailable" },
		{ models: null },
		{ models: {} },
		{ data: "invalid" },
		{ models: [{}] },
		{ models: ["A"] },
		{ models: [{ id: " " }] },
		{ models: [remoteModel("A"), null] },
	])("rejects unknown or malformed directories without replacing existing models: %j", async (payload) => {
		await withRefreshHarness(async ({ agentDir, refresh, registered, notify, fetchCatalog }) => {
			const previousModels = registered();
			const previousCache = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
			fetchCatalog.mockImplementation(async () => Response.json(payload));
			await refresh();
			expect(registered()).toBe(previousModels);
			expect(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")).toBe(previousCache);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Failed to refresh CLIProxyAPI models"), "error");
		});
	});

	it.each([
		["HTTP error", async () => new Response("unavailable", { status: 503 })],
		[
			"network error",
			async () => {
				throw new Error("network down");
			},
		],
		[
			"cancellation",
			async () => {
				throw new DOMException("cancelled", "AbortError");
			},
		],
		["non-JSON response", async () => new Response("not JSON")],
	])("keeps registration and the mapping cache unchanged on %s", async (_name, response) => {
		await withRefreshHarness(async ({ agentDir, refresh, registered, notify, fetchCatalog }) => {
			const previousModels = registered();
			const previousCache = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
			fetchCatalog.mockImplementation(response);
			await refresh();
			expect(registered()).toBe(previousModels);
			expect(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")).toBe(previousCache);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Failed to refresh CLIProxyAPI models"), "error");
			expect(notify).not.toHaveBeenCalledWith(expect.anything(), "info");
		});
	});

	it.each([
		["models envelope", { models: [] }],
		["data envelope", { data: [] }],
		["bare array", []],
		["all hidden", { models: [{ ...remoteModel("A"), visibility: "hide" }] }],
	])("registers an explicit empty catalog for %s and allows later refreshes", async (_name, payload) => {
		await withRefreshHarness(async ({ agentDir, pi, refresh, registered, notify, fetchCatalog }) => {
			fetchCatalog.mockImplementation(async () => Response.json(payload));
			await refresh();
			expect(registered()).toEqual([]);
			const cache = loadModelsCache(agentDir, BASE_URL);
			expect(cache?.models).toEqual([]);
			expect(cache?.fastModelIds).toEqual([]);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 0 CLIProxyAPI models"), "info");
			const provider = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
			expect(provider.oauth.login).toBeTypeOf("function");

			fetchCatalog.mockImplementation(async () => catalog([remoteModel("A")]));
			await refresh();
			expect(registered()?.map((model) => model.id)).toEqual(["A"]);
			expect(loadModelsCache(agentDir, BASE_URL)?.fastModelIds).toEqual(["A"]);
		});
	});

	it("synchronizes additions, hiding and reappearance without retaining hidden Fast IDs", async () => {
		await withRefreshHarness(async ({ agentDir, refresh, registered, fetchCatalog }) => {
			fetchCatalog.mockImplementation(async () =>
				Response.json({
					models: [remoteModel("A"), { ...remoteModel("B"), visibility: "hide" }, remoteModel("C", false)],
				}),
			);
			await refresh();
			expect(registered()?.map((model) => model.id)).toEqual(["A", "C"]);
			expect(loadModelsCache(agentDir, BASE_URL)?.models.map((model) => model.id)).toEqual(["A", "C"]);
			expect(loadModelsCache(agentDir, BASE_URL)?.fastModelIds).toEqual(["A"]);

			fetchCatalog.mockImplementation(async () => catalog([remoteModel("B"), remoteModel("C", false)]));
			await refresh();
			expect(registered()?.map((model) => model.id)).toEqual(["B", "C"]);
			const cache = loadModelsCache(agentDir, BASE_URL);
			expect(cache?.models.map((model) => model.id)).toEqual(["B", "C"]);
			expect(cache?.models.every((model) => model.stale === false && model.staleSince === undefined)).toBe(true);
			expect(cache?.fastModelIds).toEqual(["B"]);
		});
	});

	it("removes B from registration, mapping cache and Fast IDs when the remote catalog only has A", async () => {
		await withRefreshHarness(async ({ agentDir, pi, refresh, registered, notify, fetchCatalog }) => {
			fetchCatalog.mockImplementation(async () => catalog([remoteModel("A")]));

			await refresh();

			expect(registered()?.map((model) => model.id)).toEqual(["A"]);
			const cache = loadModelsCache(agentDir, BASE_URL);
			expect(cache?.models.map((model) => model.id)).toEqual(["A"]);
			expect(cache?.fastModelIds).toEqual(["A"]);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1 CLIProxyAPI models"), "info");
			expect(pi.setModel).not.toHaveBeenCalled();
			expect(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")).not.toContain('"B"');
		});
	});
});
