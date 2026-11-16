/**
 * Free Proxy Pool: automatically fetches public HTTP proxies from several sources,
 * live-tests each one against TikTok's API (JSON response = the proxy's country is NOT
 * region-blocked), and keeps the healthy ones in SQLite for the bot to use.
 *
 * No credentials are ever used during pool validation - only an anonymous GET, so the
 * pool never touches the user's session.
 */
import { request, ProxyAgent } from "undici";
import { db } from "@/lib/db";

export interface PoolProxy {
  host: string;
  port: number;
  proxyUrl: string;
}

export interface PoolRefreshResult {
  scanned: number;
  okCount: number;
  healthy: number;
  best: PoolProxy | null;
}

const SOURCES: Array<{ url: string; kind: "text" | "geonode" }> = [
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", kind: "text" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", kind: "text" },
  {
    url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
    kind: "text",
  },
  { url: "https://www.proxy-list.download/api/v1/get?type=http", kind: "text" },
  {
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
    kind: "geonode",
  },
];

const TikTokCheckUrl = "https://www.tiktok.com/api/v1/video/upload/auth/?aid=1988";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Fetches all source lists and returns a deduped, shuffled candidate list. */
export async function fetchCandidates(max: number): Promise<Array<{ host: string; port: number; country: string }>> {
  const map = new Map<string, string>(); // "host:port" -> country
  await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const res = await fetch(src.url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return;
        if (src.kind === "text") {
          const text = await res.text();
          for (const line of text.split(/\r?\n/)) {
            const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
            if (m) map.set(`${m[1]}:${m[2]}`, "");
          }
        } else {
          const json = (await res.json()) as { data?: Array<{ ip?: string; port?: number | string; country?: string }> };
          for (const p of json.data ?? []) {
            if (p.ip && p.port) {
              const port = Number(p.port);
              if (Number.isFinite(port) && port > 0 && port < 65536) {
                map.set(`${p.ip}:${port}`, p.country ?? "");
              }
            }
          }
        }
      } catch {
        /* source unavailable this round - fine */
      }
    }),
  );
  const all = shuffle([...map.entries()]).map(([key, country]) => {
    const [host, port] = key.split(":");
    return { host, port: Number(port), country };
  });
  return all.slice(0, max);
}

/**
 * Checks one proxy against TikTok. Success = TikTok is reachable from the proxy's
 * country and it is NOT the Hong Kong "service discontinued" page:
 *  - any JSON API answer            -> pass (best case)
 *  - 30x redirect within tiktok.com -> follow; final page without the HK marker -> pass
 *  - 30x to a non-tiktok domain     -> fail (hijack proxy)
 *  - HK "discontinued" page         -> fail (region blocked)
 * Returns latency ms or null.
 */
async function checkProxy(host: string, port: number): Promise<number | null> {
  const dispatcher = new ProxyAgent(`http://${host}:${port}`);
  const started = Date.now();
  try {
    let url = TikTokCheckUrl;
    for (let hop = 0; hop < 3; hop++) {
      const res = await request(url, {
        headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
        dispatcher,
        headersTimeout: 8000,
        bodyTimeout: 8000,
      });
      const text = await res.body.text();
      res.body.destroy();

      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers["location"];
        const locStr = Array.isArray(loc) ? loc[0] : loc;
        if (!locStr || !locStr.includes("tiktok.com")) return null; // hijacked -> junk proxy
        url = locStr;
        continue;
      }

      if (res.statusCode !== 200) return null;
      const lower = text.toLowerCase();
      if (text.trimStart().startsWith("{")) return Date.now() - started; // JSON API answered
      if (lower.includes("discontinued operating tiktok")) return null; // HK region block
      if (lower.includes("<html") && lower.includes("tiktok")) return Date.now() - started; // real TikTok web page
      return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      dispatcher.close();
    } catch {
      /* ignore */
    }
  }
}

/** Runs a bounded worker pool over candidates, returning the ones that passed. */
async function runChecks(
  candidates: Array<{ host: string; port: number; country: string }>,
  concurrency: number,
): Promise<Array<{ host: string; port: number; country: string; latencyMs: number }>> {
  const passed: Array<{ host: string; port: number; country: string; latencyMs: number }> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const c = candidates[cursor++];
      const latency = await checkProxy(c.host, c.port);
      if (latency !== null) passed.push({ ...c, latencyMs: latency });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return passed.sort((a, b) => a.latencyMs - b.latencyMs);
}

/** Fetches candidates, tests them, updates the ProxyNode table. */
export async function refreshPool(maxCandidates = 220, concurrency = 24): Promise<PoolRefreshResult> {
  const candidates = await fetchCandidates(maxCandidates);
  const passed = candidates.length ? await runChecks(candidates, concurrency) : [];

  const now = new Date();
  for (const p of passed) {
    await db.proxyNode.upsert({
      where: { host_port: { host: p.host, port: p.port } },
      create: { host: p.host, port: p.port, country: p.country, latencyMs: p.latencyMs, okCount: 1, lastOkAt: now },
      update: { latencyMs: p.latencyMs, okCount: { increment: 1 }, lastOkAt: now, failCount: 0, country: p.country },
    });
  }

  // Mark existing nodes that failed this round; drop them after 3 consecutive failures.
  const passedKeys = new Set(passed.map((p) => `${p.host}:${p.port}`));
  const existing = await db.proxyNode.findMany();
  await Promise.all(
    existing
      .filter((n) => !passedKeys.has(`${n.host}:${n.port}`))
      .map(async (n) => {
        if (n.failCount + 1 >= 3) {
          await db.proxyNode.delete({ where: { id: n.id } });
        } else {
          await db.proxyNode.update({ where: { id: n.id }, data: { failCount: { increment: 1 } } });
        }
      }),
  );

  const best = await pickBest();
  return { scanned: candidates.length, okCount: passed.length, healthy: await db.proxyNode.count(), best };
}

export function toProxyUrl(node: { host: string; port: number }): string {
  return `http://${node.host}:${node.port}`;
}

/**
 * Top N healthy proxies, best first: recently verified, fewest consecutive failures,
 * lowest latency. `excludeHosts` lets callers skip nodes that already failed in this request.
 */
export async function pickTop(n: number, excludeHosts: string[] = []): Promise<PoolProxy[]> {
  const nodes = await db.proxyNode.findMany({
    where: excludeHosts.length ? { host: { notIn: excludeHosts } } : undefined,
    orderBy: [{ lastOkAt: "desc" }, { okCount: "desc" }, { latencyMs: "asc" }],
    take: Math.max(n * 3, 12),
  });
  return nodes
    // 2+ strikes wale nodes selection se bahar (documented behavior), warna mara hua
    // proxy bar bar top-4 me ghus kar poori login fail-fast kar deta tha.
    .filter((node) => node.failCount < 2)
    .sort((a, b) => a.failCount - b.failCount || a.latencyMs - b.latencyMs)
    .slice(0, Math.max(n, 0))
    .map((node) => ({ host: node.host, port: node.port, proxyUrl: toProxyUrl(node) }));
}

/** Best healthy proxy (fastest, recently verified), optionally excluding one host. */
export async function pickBest(exclude?: string): Promise<PoolProxy | null> {
  const top = await pickTop(1, exclude ? [exclude] : []);
  return top[0] ?? null;
}

/** Any other healthy proxy than the given host (for retries). */
export async function pickAlternate(currentHost: string): Promise<PoolProxy | null> {
  return pickBest(currentHost);
}

// ---------------------------------------------------------------- liveness probing

/**
 * Fast liveness check: "kya is proxy ke through TikTok se KOI BHI HTTP jawab aata hai?"
 * DB sorting (okCount/latency) par bharosa karna kaafi nahi - free proxies validation ke
 * kuch minute/hours baad hi mar jaate hain. Probe ka koi bhi HTTP status (200/302/403...)
 * kaafi hai, hum content nahi dekhte - region block checkSession khud handle karta hai.
 */
export async function probeProxy(proxyUrl: string, timeoutMs = 8000): Promise<boolean> {
  let dispatcher: ProxyAgent | undefined;
  try {
    // connectTimeout explicit zaroori hai: undici ka connect/CONNECT-tunnel phase
    // request-signal ko ignore karta hai aur default 10s (kabhi-kabhi 60s+) leta hai.
    dispatcher = new ProxyAgent({ uri: proxyUrl, connectTimeout: timeoutMs });
    const res = await request(TikTokCheckUrl, {
      method: "GET",
      headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
      dispatcher,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs + 1000),
    });
    res.body.destroy(); // content nahi chahiye, sirf "koi jawab aaya" ka signal
    return res.statusCode > 0;
  } catch {
    return false;
  } finally {
    try {
      dispatcher?.destroy(); // close() socket ka wait karta hai, destroy() force-kill karta hai
    } catch {
      /* ignore */
    }
  }
}

/**
 * Top healthy candidates ko PARALLEL probe karta hai aur pehla zinda proxy deta hai
 * (candidates already best-first sorted hain). Mare hue nodes par 1 strike lagta hai -
 * 2 strikes par pickTop unhe selection se hata deta hai. Null = top set me kuch zinda nahi.
 */
export async function pickLiveProxy(excludeHosts: string[] = [], count = 12): Promise<PoolProxy | null> {
  const candidates = await pickTop(count, excludeHosts);
  if (!candidates.length) return null;
  // Hard deadline: undici ke hang quirks ke against belt-and-suspenders (routable-lekin-
  // stall hue CONNECT tunnels kabhi kabhi deadline ke baad bhi latke rehte hain).
  const withDeadline = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([p, timeoutP]).finally(() => clearTimeout(timer));
  };
  const results = await Promise.all(
    candidates.map(async (c) => ({
      c,
      alive: await withDeadline(probeProxy(c.proxyUrl, 8000).catch(() => false), 11000, false),
    })),
  );
  // Dead nodes ko penalize karo (chahe koi zinda mila ho) - pool hygiene better hoti hai.
  await Promise.all(
    results
      .filter((r) => !r.alive)
      .map((r) => penalizeProxy(r.c.proxyUrl, 1).catch(() => undefined)),
  );
  return results.find((r) => r.alive)?.c ?? null;
}

// Concurrent refresh guard: do jobs ek sath refresh trigger na kar saken.
let refreshInFlight: Promise<PoolRefreshResult> | null = null;

/**
 * refreshPool with single-flight guard + on-demand use ke liye chhota default scan.
 * Job runner ye tab use karta hai jab pool ke top candidates ke probes fail ho jayen.
 */
export async function refreshPoolOnce(maxCandidates = 160, concurrency = 32): Promise<PoolRefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshPool(maxCandidates, concurrency).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Penalizes a node that just failed a real session request (2 strikes = dropped from
 * selection immediately, 3 = deleted by the next refresh). Manual (user) proxies that
 * are not in the pool are silently ignored.
 */
export async function penalizeProxy(proxyUrl: string, weight = 2): Promise<void> {
  try {
    const u = new URL(proxyUrl);
    await db.proxyNode.updateMany({
      where: { host: u.hostname, port: Number(u.port) || 0 },
      data: { failCount: { increment: weight } },
    });
  } catch {
    /* not a parsable pool proxy - ignore */
  }
}

/**
 * True for raw network errors (dead proxy / connect timeout / DNS / reset). These are
 * worth retrying on a different pool node; TikTok's own JSON errors are not.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (
    [
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_ABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPROTO",
      "ERR_SOCKET_CONNECTION_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("connect timeout") ||
    msg.includes("connection timeout") ||
    msg.includes("socket hang up") ||
    msg.includes("other side closed") ||
    msg.includes("fetch failed") ||
    msg.includes("request aborted")
  );
}
