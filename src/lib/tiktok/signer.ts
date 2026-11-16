/**
 * TikTok request signer (the `_signature` and `X-Bogus` query parameters TikTok's web client
 * adds to the publish request).
 *
 * TikTok's own obfuscated JavaScript (signer.js / webmssdk.js / xbogus.js) computes these, so it
 * runs inside a headless Chromium page on the www.tiktok.com origin. The page never talks to the
 * network: every request is answered locally with a stub HTML, exactly like the open-source
 * autotok uploader does. One browser/page is started lazily and reused for all signatures.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const VERIFY_FP = "verify_5b161567bda98b6a50c0414d99909d4b";
const PAGE_URL = "https://www.tiktok.com/api/v1/web/project/post/";
const STUB_HTML = "<!doctype html><html><head></head><body></body></html>";

export interface Signature {
  /** The `_signature` value (from byted_acrawler.sign). */
  signature: string;
  /** The `X-Bogus` value (from generateBogus). */
  xBogus: string;
  verifyFp: string;
}

interface SigningWindow {
  byted_acrawler?: { sign(options: { url: string }): string };
  generateBogus?(query: string, userAgent: string): string;
}

function findChromiumExecutable(): string {
  // 1. Explicit override
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  // 2. Playwright cache (~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome)
  const cacheDir = join(os.homedir(), ".cache", "ms-playwright");
  try {
    if (existsSync(cacheDir)) {
      const entries = readdirSync(cacheDir)
        .filter((d) => d.startsWith("chromium-") || d.startsWith("chromium_headless_shell-"))
        .sort()
        .reverse();
      for (const dir of entries) {
        for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
          const p = join(cacheDir, dir, sub);
          if (existsSync(p)) return p;
        }
      }
    }
  } catch {
    /* fall through */
  }
  // 3. System chromium
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("Chromium nahi mila (signer ke liye zaroori hai). CHROMIUM_PATH env var set karein.");
}

class SignerService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  private scripts: string[] | null = null;
  private lastUsed = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private loadScripts(): string[] {
    if (!this.scripts) {
      const dir = join(process.cwd(), "src", "lib", "tiktok", "signer_js");
      this.scripts = ["signer.js", "webmssdk.js", "xbogus.js"].map((f) => readFileSync(join(dir, f), "utf8"));
    }
    return this.scripts;
  }

  async getPage(): Promise<Page> {
    if (this.page) {
      this.lastUsed = Date.now();
      return this.page;
    }
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Page> {
    const executablePath = findChromiumExecutable();
    this.browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--disable-extensions"],
    });
    this.context = await this.browser.newContext({ bypassCSP: true });
    const page = await this.context.newPage();

    // Never let the signing page reach the network.
    await page.route("**/*", (route) => {
      if (route.request().resourceType() === "document") {
        return route.fulfill({ status: 200, contentType: "text/html", body: STUB_HTML }).catch(() => {});
      }
      return route.abort().catch(() => {});
    });

    await page.goto(PAGE_URL, { waitUntil: "load", timeout: 20000 });
    for (const script of this.loadScripts()) {
      await page.addScriptTag({ content: script });
    }
    await page.waitForFunction(
      "() => !!(window.byted_acrawler && typeof window.byted_acrawler.sign === 'function' && typeof window.generateBogus === 'function')",
      { timeout: 20000 },
    );
    this.page = page;
    this.lastUsed = Date.now();
    this.scheduleIdleClose();
    return page;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Close the browser after 10 minutes of inactivity to save memory.
    this.idleTimer = setTimeout(
      () => {
        if (Date.now() - this.lastUsed >= 10 * 60 * 1000) void this.close();
        else this.scheduleIdleClose();
      },
      10 * 60 * 1000,
    );
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  /** Sign a TikTok API url (query included). verifyFp: the session's own s_v_web_id when known. */
  async sign(url: string, userAgent: string, verifyFp?: string): Promise<Signature> {
    const page = await this.getPage();
    const fp = verifyFp && verifyFp.startsWith("verify_") ? verifyFp : VERIFY_FP;
    const sep = url.includes("?") ? "&" : "?";
    const urlFp = `${url}${sep}verifyFp=${fp}`;

    const signature = await page.evaluate((u: string) => {
      const w = window as unknown as SigningWindow;
      return w.byted_acrawler!.sign({ url: u });
    }, urlFp);

    const signedUrl = `${urlFp}&_signature=${signature}`;
    const query = await page.evaluate((u: string) => new URL(u).searchParams.toString(), signedUrl);
    const xBogus = await page.evaluate(
      ([q, ua]: [string, string]) => {
        const w = window as unknown as SigningWindow;
        return w.generateBogus!(q, ua);
      },
      [query, userAgent],
    );

    if (!signature || !xBogus) throw new Error("Signing fail ho gayi (khali signature).");
    return { signature, xBogus, verifyFp: fp };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
    }
  }
}

const globalForSigner = globalThis as unknown as { tiktokSigner: SignerService | undefined };

export const signer: SignerService = globalForSigner.tiktokSigner ?? new SignerService();
if (process.env.NODE_ENV !== "production") globalForSigner.tiktokSigner = signer;
