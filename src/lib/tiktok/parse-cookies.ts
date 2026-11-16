/**
 * Parses TikTok cookies pasted by the user. Accepts:
 *  1. Cookie Editor "Export -> JSON": a JSON array of cookie objects
 *  2. A JSON object of { name: value, ... }
 *  3. A raw `Cookie:` header string: "name1=value1; name2=value2"
 */
import { CookieJar } from "./cookie-jar";

export interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number | string | null;
  secure?: boolean;
}

export interface ParseResult {
  jar: CookieJar;
  count: number;
  hasSessionId: boolean;
  datacenter: string; // tt-target-idc value, "" if missing
  hasMsToken: boolean;
}

export function parsePastedCookies(input: string): ParseResult {
  const text = input.trim();
  if (!text) throw new Error("Cookie khali hai - pehle TikTok ki cookies paste karein.");

  let parsed: ParsedCookie[];

  if (text.startsWith("[") || text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Cookie JSON parse nahi hui. Cookie Editor me 'Export -> JSON' use karein.");
    }
    if (Array.isArray(json)) {
      parsed = json as ParsedCookie[];
    } else if (json && typeof json === "object") {
      parsed = Object.entries(json as Record<string, string>).map(([name, value]) => ({ name, value }));
    } else {
      throw new Error("Cookie format samajh nahi aaya. JSON array ya 'name=value; ...' string paste karein.");
    }
  } else {
    parsed = text.split(";").map((pair) => {
      const i = pair.indexOf("=");
      if (i === -1) return { name: pair.trim(), value: "" };
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
    });
  }

  const jar = new CookieJar();
  let hasSessionId = false;
  let datacenter = "";
  let hasMsToken = false;

  for (const c of parsed) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") continue;
    if (!c.name.trim() || !c.value.trim()) continue;
    jar.set(c.name.trim(), c.value.trim(), {
      domain: c.domain && typeof c.domain === "string" ? c.domain : ".tiktok.com",
      path: c.path && typeof c.path === "string" ? c.path : "/",
      secure: c.secure === true,
      expires: null,
    });
    const n = c.name.trim();
    if (n === "sessionid" || n === "sessionid_ss") hasSessionId = true;
    if (n === "tt-target-idc") datacenter = c.value.trim();
    if (n === "msToken") hasMsToken = true;
  }

  if (!hasSessionId) {
    throw new Error(
      "Isme 'sessionid' cookie nahi mili. TikTok me login karke phir cookies nikalein (sessionid zaroori hai).",
    );
  }

  return { jar, count: jar.all().length, hasSessionId, datacenter, hasMsToken };
}
