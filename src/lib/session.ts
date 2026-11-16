import { NextRequest } from "next/server";

/**
 * Bot ka apna login session id.
 *
 * Background: ye app chat.z.ai ke preview iframe ke andar bhi khulti hai. Wahan
 * browser SameSite=Lax cookie ko cross-site request par bhejta hi nahi (aur
 * third-party cookie block hone par set bhi nahi karta) — isliye login ke foran
 * baad bhi Post button 401 deta tha ("Session expire" ka galat message).
 *
 * Hal: session id ko cookie ke ilawa `x-tt-sid` header se bhi accept karte hain.
 * Frontend login ke jawab me mila sid localStorage me rakhta hai aur har API
 * call par header me bhejta hai — iframe me bhi kaam karta hai.
 */
export const SESSION_COOKIE = "tt_bot_sid";
export const SESSION_HEADER = "x-tt-sid";
export const SESSION_STORAGE_KEY = "tt_bot_sid";

/** Session id: header (iframe-safe) pehle, phir cookie (top-level tab). */
export function resolveSessionId(req: NextRequest): string {
  const header = req.headers.get(SESSION_HEADER)?.trim();
  if (header) return header;
  return req.cookies.get(SESSION_COOKIE)?.value?.trim() ?? "";
}

/**
 * Cookie options jo dono jagah kaam karein:
 *  - HTTPS par (preview gateway): SameSite=None; Secure; Partitioned (CHIPS) —
 *    taake cross-site iframe me bhi cookie save/send ho sake.
 *  - Local http par: SameSite=Lax (None+Secure plain http par browsers reject karte hain).
 */
export function sessionCookieOptions(req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const isHttps = proto.split(",")[0].trim() === "https";
  return {
    httpOnly: true,
    sameSite: (isHttps ? "none" : "lax") as "none" | "lax",
    secure: isHttps,
    path: "/",
    ...(isHttps ? { partitioned: true } : {}),
  };
}
