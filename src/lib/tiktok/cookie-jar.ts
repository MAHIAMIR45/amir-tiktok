/**
 * Minimal RFC 6265 cookie jar, tailored for TikTok:
 * domain/path matching, expiry, replacement, and Set-Cookie storage.
 * (Same approach as the open-source autotok/tiktok uploaders.)
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Without a leading dot. */
  domain: string;
  /** Host-only cookies are sent to `domain` exactly; domain cookies also to its subdomains. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  /** Epoch milliseconds, or null for session cookies. */
  expires: number | null;
}

const isExpired = (c: StoredCookie, now: number) => c.expires !== null && c.expires <= now;

function domainMatches(host: string, cookie: StoredCookie): boolean {
  if (host === cookie.domain) return true;
  return !cookie.hostOnly && host.endsWith(`.${cookie.domain}`);
}

function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  if (path.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) return true;
    if (path[cookiePath.length] === "/") return true;
  }
  if (path === "/" && cookiePath === "/") return true;
  return false;
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  /** Set a cookie directly. A domain with a leading dot covers subdomains. */
  set(
    name: string,
    value: string,
    opts: { domain?: string; path?: string; expires?: number | null; secure?: boolean } = {},
  ): void {
    const domain = (opts.domain ?? ".tiktok.com").replace(/^\./, "").toLowerCase();
    this.put({
      name,
      value,
      domain,
      hostOnly: !(opts.domain ?? ".tiktok.com").startsWith("."),
      path: opts.path ?? "/",
      secure: opts.secure ?? false,
      expires: opts.expires ?? null,
    });
  }

  /** The value of the most recently set cookie with this name (or undefined). */
  get(name: string): string | undefined {
    const now = Date.now();
    for (let i = this.cookies.length - 1; i >= 0; i--) {
      const c = this.cookies[i];
      if (c.name === name && !isExpired(c, now)) return c.value;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  all(): StoredCookie[] {
    const now = Date.now();
    return this.cookies.filter((c) => !isExpired(c, now)).map((c) => ({ ...c }));
  }

  names(): string[] {
    return this.all().map((c) => c.name);
  }

  /** The `Cookie` header for a request to `url`, or undefined when nothing applies. */
  header(url: URL): string | undefined {
    const host = url.hostname.toLowerCase();
    const now = Date.now();
    const pairs = this.cookies
      .filter(
        (c) =>
          !isExpired(c, now) &&
          domainMatches(host, c) &&
          pathMatches(url.pathname, c.path) &&
          (!c.secure || url.protocol === "https:"),
      )
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`);
    return pairs.length ? pairs.join("; ") : undefined;
  }

  /** Store the Set-Cookie headers of a response to `url`. */
  store(url: URL, setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const cookie = parseSetCookie(url, line);
      if (cookie) this.put(cookie);
    }
  }

  private put(cookie: StoredCookie): void {
    this.cookies = this.cookies.filter(
      (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
    );
    if (!isExpired(cookie, Date.now())) this.cookies.push(cookie);
  }
}

function parseSetCookie(url: URL, line: string): StoredCookie | null {
  const parts = line.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf("=");
  if (eq === -1) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name) return null;

  let domain = url.hostname.toLowerCase();
  let hostOnly = true;
  let path = "/";
  let secure = false;
  let expires: number | null = null;

  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? "" : attr.slice(i + 1).trim();
    if (key === "domain") {
      if (val) {
        domain = val.replace(/^\./, "").toLowerCase();
        hostOnly = false;
      }
    } else if (key === "path") {
      if (val) path = val;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    } else if (key === "max-age") {
      const s = parseInt(val, 10);
      if (!Number.isNaN(s)) {
        if (s <= 0) return null; // already expired
        expires = Date.now() + s * 1000;
      }
    }
  }
  return { name, value, domain, hostOnly, path, secure, expires };
}
