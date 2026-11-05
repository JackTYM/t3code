// Runs on Cloudflare Workers: no node or repo imports.
export interface Env {
  readonly ORIGIN?: string;
}

type FetchImpl = (
  input: string,
  init?: RequestInit & { cf?: { cacheTtl: number } },
) => Promise<Response>;

const DEFAULT_ORIGIN = "https://jacktym.github.io/t3code";

// expo-updates 58 rejects responses without these, and static hosts cannot set headers.
const PROTOCOL_HEADERS = { "expo-protocol-version": "1", "expo-sfv-version": "0" } as const;

export async function handle(request: Request, env: Env, fetchImpl: FetchImpl): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/ios/manifest") return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const origin = (env.ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  const upstream = await fetchImpl(`${origin}/ota/ios/manifest.json`, {
    method: request.method,
    cf: { cacheTtl: 60 },
  });

  // A missing manifest means nothing has been published yet, which expo-updates reads as "no update".
  if (upstream.status === 404)
    return new Response(null, { status: 204, headers: PROTOCOL_HEADERS });
  if (!upstream.ok) return new Response("Upstream manifest unavailable", { status: 502 });

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, max-age=0",
      ...PROTOCOL_HEADERS,
    },
  });
}

export default {
  fetch(request: Request, env: Env) {
    return handle(request, env, fetch);
  },
};
