import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parsePastedCookies, type ParseResult } from "@/lib/tiktok/parse-cookies";
import { TikTokError, TikTokHttp, checkSession, DEFAULT_UA } from "@/lib/tiktok/client";
import { refreshPool, pickTop, penalizeProxy, isConnectionError, type PoolProxy } from "@/lib/tiktok/proxy-pool";
import { SESSION_COOKIE, resolveSessionId, sessionCookieOptions } from "@/lib/session";
import { proxyMode } from "@/lib/tiktok/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface SessionInfo {
  authenticated: boolean;
  username: string;
  nickname: string;
  avatarUrl: string;
  userId: string;
  cookieCount: number;
  datacenter: string;
  hasMsToken: boolean;
  proxy: string;
  proxyAuto: boolean;
  loggedInAt: string;
}

function maskProxy(proxy: string): string {
  if (!proxy) return "";
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.username ? "user:***@" : ""}${u.hostname}:${u.port}`;
  } catch {
    return "***";
  }
}

async function loadSessionInfo(id: string | undefined): Promise<SessionInfo | null> {
  if (!id) return null;
  const session = await db.tikTokSession.findUnique({ where: { id } });
  if (!session) return null;
  const cookies = JSON.parse(session.cookies) as Array<{ name: string }>;
  return {
    authenticated: true,
    username: session.username,
    nickname: session.nickname || (session.username ? `@${session.username}` : "TikTok User"),
    avatarUrl: session.avatarUrl,
    userId: session.userId,
    cookieCount: cookies.length,
    datacenter: session.datacenter,
    hasMsToken: cookies.some((c) => c.name === "msToken"),
    proxy: maskProxy(session.proxy),
    proxyAuto: session.proxy !== "" && !session.proxy.includes("@"),
    loggedInAt: session.createdAt.toISOString(),
  };
}

function sessionCookieOptionsFor(req: NextRequest) {
  return { ...sessionCookieOptions(req), maxAge: 60 * 60 * 24 * 30 }; // 30 days
}

/** GET /api/auth -> current login state (cookie ya x-tt-sid header dono chalte hain) */
export async function GET(req: NextRequest) {
  try {
    const id = resolveSessionId(req);
    const info = await loadSessionInfo(id);
    if (!info) return NextResponse.json({ authenticated: false, info: null });
    return NextResponse.json({ authenticated: true, info });
  } catch {
    return NextResponse.json({ authenticated: false, info: null });
  }
}

/**
 * Verifies the pasted cookies through one proxy and stores the session row.
 * Throws TikTokError with a precise code on any failure.
 */
async function verifyAndStore(
  req: NextRequest,
  parsed: ParseResult,
  proxy: string,
  proxyAuto: boolean,
): Promise<NextResponse> {
  const http = new TikTokHttp(parsed.jar, DEFAULT_UA, proxy);
  const check = await checkSession(http); // throws TikTokError with precise code/message

  // User ka asli browser UA save karo: TikTok sessionid usi UA ko issue karta hai,
  // isi liye har TikTok request me wahi UA bhejna session zinda rakhne me madadgar hai.
  const userAgent = req.headers.get("user-agent") ?? "";

  // Keep only one active login: replace the old row.
  await db.tikTokSession.deleteMany({});
  const session = await db.tikTokSession.create({
    data: {
      cookies: JSON.stringify(parsed.jar.all()),
      proxy,
      userAgent,
      datacenter: parsed.datacenter,
      userId: check.userId,
      username: check.username,
      nickname: check.nickname || check.username || "TikTok User",
      avatarUrl: check.avatarUrl,
    },
  });

  const res = NextResponse.json({
    ok: true,
    // Frontend ise localStorage me rakhta hai aur har API call par x-tt-sid header
    // me bhejta hai — iframe/preview me cookie block ho to bhi session zinda rehta hai.
    sid: session.id,
    info: {
      authenticated: true,
      username: session.username,
      nickname: session.nickname,
      avatarUrl: session.avatarUrl,
      userId: session.userId,
      cookieCount: parsed.count,
      datacenter: parsed.datacenter,
      hasMsToken: parsed.hasMsToken,
      proxy: maskProxy(proxy),
      proxyAuto,
      loggedInAt: session.createdAt.toISOString(),
    } as SessionInfo,
  });
  res.cookies.set(SESSION_COOKIE, session.id, sessionCookieOptionsFor(req));
  return res;
}

/** Short human-readable reason for one failed proxy attempt. */
function describeAttempt(host: string, err: unknown): string {
  if (isConnectionError(err)) return `${host} (proxy dead/timeout)`;
  if (err instanceof TikTokError) {
    if (err.code === "region_blocked") return `${host} (TikTok ne block kiya)`;
    return `${host} (${err.code})`;
  }
  return `${host} (fail)`;
}

/**
 * POST /api/auth { cookies: "...", proxy?: "http://..." } -> validate + store.
 *
 * Proxy strategy:
 *  - Manual proxy given  -> single verification; clear Roman-Urdu error if it is dead.
 *  - No proxy (auto)     -> try the top pool nodes ONE BY ONE (a dead free proxy no
 *                           longer kills the login), penalize every failed node, and
 *                           if all of them fail refresh the pool once and try fresh ones.
 *  - Cookies invalid (TikTok answered JSON = proxy works) -> fail fast, no proxy retries.
 */
export async function POST(req: NextRequest) {
  const attempts: string[] = [];
  try {
    const body = (await req.json()) as { cookies?: string; proxy?: string };
    const parsed = parsePastedCookies(body.cookies ?? "");
    const manualProxy = (body.proxy ?? "").trim();

    // ---------- DIRECT mode (Render/VPS jaisa TikTok-supported region): server ka apna IP,
    // koi proxy nahi. Ek network-error retry ke sath single attempt.
    if (!manualProxy && proxyMode() === "direct") {
      try {
        return await verifyAndStore(req, parsed, "", true);
      } catch (err) {
        if (err instanceof TikTokError && ["session_invalid", "region_blocked"].includes(err.code)) throw err;
        if (isConnectionError(err)) {
          // network hiccup: ek dafa dobara
          try {
            return await verifyAndStore(req, parsed, "", true);
          } catch (err2) {
            if (err2 instanceof TikTokError) throw err2;
            throw new TikTokError(
              "TikTok tak connection nahi ban paya (network error). 10 second baad Login dobara dabayein.",
              "network",
            );
          }
        }
        throw err;
      }
    }

    // ---------- manual proxy: single shot ----------
    if (manualProxy) {
      try {
        return await verifyAndStore(req, parsed, manualProxy, false);
      } catch (err) {
        if (err instanceof TikTokError && ["session_invalid", "bad_proxy"].includes(err.code)) throw err;
        if (isConnectionError(err)) {
          throw new TikTokError(
            "Aapka proxy connect hi nahi ho raha (timeout/refused) - ye proxy dead ya bohat slow hai. Doosra HTTP proxy try karein, ya Proxy field khali chhor dein taake bot free pool se khud healthy proxy utha le.",
            "proxy_dead",
          );
        }
        throw err;
      }
    }

    // ---------- auto mode: pool chain ----------
    let candidates = await pickTop(4);
    if (!candidates.length) {
      // Empty pool: build it once now (bounded, ~40-80s).
      await refreshPool(140, 20);
      candidates = await pickTop(4);
    }

    for (const cand of candidates) {
      try {
        return await verifyAndStore(req, parsed, cand.proxyUrl, true);
      } catch (err) {
        // TikTok ne properly jawab diya -> proxy CHAL raha hai, to cookies kharab hain: fail fast.
        // (bad_proxy yahan fail-fast NAHIN: pool ka koi node ghalat ho to agla node try karo.)
        if (err instanceof TikTokError && err.code === "session_invalid") throw err;
        attempts.push(describeAttempt(cand.host, err));
        await penalizeProxy(cand.proxyUrl, 2);
      }
    }

    // ---------- every candidate failed: one bounded pool refresh, then 2 fresh nodes ----------
    let refreshed = { healthy: await db.proxyNode.count(), scanned: 0, okCount: 0 };
    const fresh: PoolProxy[] = [];
    if (attempts.length) {
      refreshed = await refreshPool(140, 24);
      fresh.push(...(await pickTop(2)));
    }
    for (const cand of fresh) {
      try {
        return await verifyAndStore(req, parsed, cand.proxyUrl, true);
      } catch (err) {
        if (err instanceof TikTokError && err.code === "session_invalid") throw err;
        attempts.push(describeAttempt(cand.host, err));
        await penalizeProxy(cand.proxyUrl, 2);
      }
    }

    // ---------- nothing worked ----------
    const tried = candidates.length + fresh.length;
    const summary = attempts.slice(0, 3).join(", ");
    throw new TikTokError(
      tried > 0
        ? `Bot ne ${tried} free proxies try kiye lekin koi TikTok tak nahi pahunch saka (${summary}). Pool ab refresh ho chuka hai (${refreshed.healthy} healthy) - 10 second baad Login dobara dabayein. PAKKA HAL (free aur permanent): page par sab se upar 'Pakka Hal: Direct Post (Userscript)' card use karein - video aap ke phone se seedha TikTok par jati hai, cookies ya proxy ki zaroorat hi nahi.`
        : "Free Proxy Pool khali hai aur refresh par bhi koi public proxy TikTok tak nahi pahunch saka. 1-2 minute baad dobara try karein. PAKKA HAL (free aur permanent): page par sab se upar 'Pakka Hal: Direct Post (Userscript)' card use karein - cookies ya proxy ki zaroorat hi nahi.",
      "pool_exhausted",
    );
  } catch (err) {
    const message =
      err instanceof TikTokError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Login fail ho gaya.";
    return NextResponse.json({ ok: false, error: message }, { status: err instanceof TikTokError && err.code === "pool_exhausted" ? 503 : 400 });
  }
}

/** DELETE /api/auth -> logout (clears stored cookies) */
export async function DELETE(req: NextRequest) {
  const id = resolveSessionId(req);
  if (id) await db.tikTokSession.deleteMany({ where: { id } });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptionsFor(req), maxAge: 0 });
  return res;
}
