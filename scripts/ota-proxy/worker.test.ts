import { describe, expect, it } from "vite-plus/test";
import { handle } from "./worker.ts";

const ORIGIN = "https://jacktym.github.io/t3code";
const manifest = JSON.stringify({ id: "abc", runtimeVersion: "1" });

function fakeFetch(response: Response) {
  const calls: Array<{ url: string; init: unknown }> = [];
  const impl = (url: string, init?: unknown) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  };
  return { impl, calls };
}

const get = (path: string, method = "GET") =>
  new Request(`https://ota.example.dev${path}`, { method });

describe("ota proxy worker", () => {
  it("serves the upstream manifest with the expo protocol headers", async () => {
    const { impl, calls } = fakeFetch(new Response(manifest, { status: 200 }));
    const response = await handle(get("/ios/manifest"), {}, impl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(manifest);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(calls).toEqual([
      { url: `${ORIGIN}/ota/ios/manifest.json`, init: { method: "GET", cf: { cacheTtl: 60 } } },
    ]);
  });

  it("uses ORIGIN from the environment, ignoring a trailing slash", async () => {
    const { impl, calls } = fakeFetch(new Response(manifest));
    await handle(get("/ios/manifest"), { ORIGIN: "https://example.com/pages/" }, impl);
    expect(calls[0]?.url).toBe("https://example.com/pages/ota/ios/manifest.json");
  });

  it("answers HEAD without a body", async () => {
    const { impl, calls } = fakeFetch(new Response(manifest));
    const response = await handle(get("/ios/manifest", "HEAD"), {}, impl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(calls).toHaveLength(1);
  });

  it("treats an upstream 404 as no update", async () => {
    const { impl } = fakeFetch(new Response("nope", { status: 404 }));
    const response = await handle(get("/ios/manifest"), {}, impl);
    expect(response.status).toBe(204);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(await response.text()).toBe("");
  });

  it("maps other upstream failures to 502", async () => {
    const { impl } = fakeFetch(new Response("boom", { status: 500 }));
    const response = await handle(get("/ios/manifest"), {}, impl);
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/upstream/i);
  });

  it("404s other paths without fetching upstream", async () => {
    const { impl, calls } = fakeFetch(new Response(manifest));
    expect((await handle(get("/"), {}, impl)).status).toBe(404);
    expect((await handle(get("/android/manifest"), {}, impl)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("405s other methods on the manifest path", async () => {
    const { impl, calls } = fakeFetch(new Response(manifest));
    const response = await handle(get("/ios/manifest", "POST"), {}, impl);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(calls).toHaveLength(0);
  });
});
