import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchModelsDevCostMap, matchModelCost } from "../extensions/lib.ts";

// Make native ESM exports spyable so fallback tests use an isolated temporary directory.
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual };
});

const NOW = 1_800_000_000_000;
const PROVIDERS = {
	openai: {
		name: "OpenAI",
		models: {
			"gpt-5": {
				name: "GPT-5",
				cost: { input: 5, output: 30, cache_read: 0.5 },
				limit: { context: 200000, output: 16384 },
			},
			"unpriced-model": { name: "Unpriced model", limit: { context: 32000 } },
		},
	},
};
const REFRESHED_PROVIDERS = { openai: { models: { "gpt-5": { cost: { input: 2, output: 4 } } } } };
const FAILED_REQUESTS = [
	{
		failure: "network failure",
		request: async (): Promise<Response> => {
			throw new Error("Offline");
		},
	},
	{ failure: "HTTP failure", request: async () => new Response(JSON.stringify(PROVIDERS), { status: 503 }) },
	{ failure: "invalid JSON", request: async () => new Response("{not-json") },
	{ failure: "invalid providers", request: async () => new Response("{}") },
];
const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-cliproxyapi-models-dev-test-"));
	tempDirs.push(dir);
	return dir;
}

function seedCache(agentDir: string, timestamp: number): void {
	mkdirSync(join(agentDir, "cache/cliproxyapi"), { recursive: true });
	writeFileSync(
		join(agentDir, "cache/cliproxyapi/models-dev.json"),
		JSON.stringify({ timestamp, providers: PROVIDERS }),
	);
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("models.dev agentDir cache", () => {
	it("writes the raw providers and timestamp to the agentDir cache namespace", async () => {
		const agentDir = tempAgentDir();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(PROVIDERS)));

		const catalog = await fetchModelsDevCostMap(agentDir);

		expect(matchModelCost("gpt-5", catalog)).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
		expect(JSON.parse(readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8"))).toEqual({
			timestamp: NOW,
			providers: PROVIDERS,
		});
		expect(existsSync(join(agentDir, "tmp/models-dev-cache.json"))).toBe(false);
	});

	it("reuses a cache within 24 hours without requesting models.dev or rewriting it", async () => {
		const agentDir = tempAgentDir();
		seedCache(agentDir, NOW - 86_399_999);
		const original = readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));

		const catalog = await fetchModelsDevCostMap(agentDir);

		expect(matchModelCost("gpt-5", catalog).input).toBe(5);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8")).toBe(original);
	});

	it("refreshes a cache at the 24-hour boundary and timestamps the raw replacement", async () => {
		const agentDir = tempAgentDir();
		seedCache(agentDir, NOW - 86_400_000);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(REFRESHED_PROVIDERS)));

		const catalog = await fetchModelsDevCostMap(agentDir);

		expect(matchModelCost("gpt-5", catalog).input).toBe(2);
		expect(JSON.parse(readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8"))).toEqual({
			timestamp: NOW,
			providers: REFRESHED_PROVIDERS,
		});
	});

	it("keeps cache reads, writes and offline fallback isolated between two agentDirs", async () => {
		const firstAgentDir = tempAgentDir();
		const secondAgentDir = tempAgentDir();
		seedCache(firstAgentDir, NOW);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));

		const uncached = await fetchModelsDevCostMap(secondAgentDir);
		expect(matchModelCost("gpt-5", uncached).input).toBe(0);
		expect(existsSync(join(secondAgentDir, "cache/cliproxyapi/models-dev.json"))).toBe(false);

		fetchMock.mockResolvedValue(new Response(JSON.stringify(REFRESHED_PROVIDERS)));
		await fetchModelsDevCostMap(secondAgentDir);
		fetchMock.mockClear().mockRejectedValue(new Error("Unexpected network request"));

		const first = await fetchModelsDevCostMap(firstAgentDir);
		const second = await fetchModelsDevCostMap(secondAgentDir);
		expect(matchModelCost("gpt-5", first).input).toBe(5);
		expect(matchModelCost("gpt-5", second).input).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(FAILED_REQUESTS)("retains stale data in the new location after $failure", async ({ request }) => {
		const agentDir = tempAgentDir();
		seedCache(agentDir, NOW - 86_400_001);
		const original = readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8");
		vi.spyOn(globalThis, "fetch").mockImplementation(request);

		const catalog = await fetchModelsDevCostMap(agentDir);

		expect(matchModelCost("gpt-5", catalog).input).toBe(5);
		expect(readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8")).toBe(original);
	});

	it.each(FAILED_REQUESTS)("returns an empty catalog without usable cached data after $failure", async ({
		request,
	}) => {
		const agentDir = tempAgentDir();
		vi.spyOn(globalThis, "fetch").mockImplementation(request);

		const catalog = await fetchModelsDevCostMap(agentDir);

		expect(catalog.exact.size).toBe(0);
		expect(catalog.normalized.size).toBe(0);
		expect(matchModelCost("gpt-5", catalog)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(existsSync(join(agentDir, "cache/cliproxyapi/models-dev.json"))).toBe(false);
	});

	it("aborts a stalled refresh after three seconds and returns stale cached data", async () => {
		const agentDir = tempAgentDir();
		seedCache(agentDir, NOW - 86_400_001);
		vi.useFakeTimers({ now: NOW });
		let requestSignal: AbortSignal | null | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					requestSignal = init?.signal;
					requestSignal?.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
				}),
		);

		const pending = fetchModelsDevCostMap(agentDir);
		await vi.advanceTimersByTimeAsync(2999);
		expect(requestSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(requestSignal?.aborted).toBe(true);
		expect(matchModelCost("gpt-5", await pending).input).toBe(5);
	});

	it.each(["directory creation", "file write"])("uses fetched data even when cache %s fails", async (failure) => {
		const agentDir = tempAgentDir();
		if (failure === "directory creation") {
			writeFileSync(join(agentDir, "cache"), "Not a directory");
		} else {
			mkdirSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), { recursive: true });
		}
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(PROVIDERS)));

		const catalog = await fetchModelsDevCostMap(agentDir);

		expect(matchModelCost("gpt-5", catalog)).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
	});

	it("preserves the system temporary directory fallback for standalone calls without agentDir", async () => {
		const systemTmpDir = tempAgentDir();
		vi.spyOn(os, "tmpdir").mockReturnValue(systemTmpDir);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(PROVIDERS)));

		await fetchModelsDevCostMap();
		expect(JSON.parse(readFileSync(join(systemTmpDir, "pi-cliproxyapi-models-dev-cache.json"), "utf8"))).toEqual({
			timestamp: NOW,
			providers: PROVIDERS,
		});
		fetchMock.mockClear().mockRejectedValue(new Error("Unexpected network request"));
		const cached = await fetchModelsDevCostMap();
		expect(matchModelCost("gpt-5", cached).input).toBe(5);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores and leaves both legacy locations untouched when agentDir is provided", async () => {
		const agentDir = tempAgentDir();
		const systemTmpDir = tempAgentDir();
		vi.spyOn(os, "tmpdir").mockReturnValue(systemTmpDir);
		mkdirSync(join(agentDir, "tmp"));
		const legacyPaths = [
			join(agentDir, "tmp/models-dev-cache.json"),
			join(systemTmpDir, "pi-cliproxyapi-models-dev-cache.json"),
		];
		const legacyData = JSON.stringify({ timestamp: NOW, providers: PROVIDERS });
		for (const path of legacyPaths) writeFileSync(path, legacyData);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));

		const uncached = await fetchModelsDevCostMap(agentDir);
		expect(matchModelCost("gpt-5", uncached).input).toBe(0);
		expect(fetchMock).toHaveBeenCalledWith("https://models.dev/api.json", expect.any(Object));
		expect(existsSync(join(agentDir, "cache/cliproxyapi/models-dev.json"))).toBe(false);
		for (const path of legacyPaths) expect(readFileSync(path, "utf8")).toBe(legacyData);

		fetchMock.mockResolvedValue(new Response(JSON.stringify(REFRESHED_PROVIDERS)));
		const fetched = await fetchModelsDevCostMap(agentDir);
		expect(matchModelCost("gpt-5", fetched).input).toBe(2);
		expect(JSON.parse(readFileSync(join(agentDir, "cache/cliproxyapi/models-dev.json"), "utf8"))).toEqual({
			timestamp: NOW,
			providers: REFRESHED_PROVIDERS,
		});
		for (const path of legacyPaths) expect(readFileSync(path, "utf8")).toBe(legacyData);
	});
});
