/**
 * TikTok web upload client: logs a pasted cookie session in, uploads a video to TikTok's
 * storage and publishes it with caption + hashtags.
 *
 * Implements the same request flow as the open-source autotok / MiniGlome TikTok uploaders
 * (project/create -> upload/auth -> ApplyUploadInner -> chunked PUT -> finish -> CommitUploadInner
 * -> signed project/post), but in TypeScript with undici so that exact headers are sent.
 */
import { request, ProxyAgent, type Dispatcher } from "undici";
import { createReadStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CookieJar } from "./cookie-jar";
import { signV4, type AwsCredentials } from "./sigv4";
import { signer } from "./signer";

export const TT = "https://www.tiktok.com";
export const AID = 1988;
export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const MAX_CAPTION_LENGTH = 2200;
const DEFAULT_DATACENTER = "useast2a";
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB, same as TikTok's web client
const AWS_REGION = "ap-singapore-1";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Headers the real Chrome web client sends with every same-origin API call. */
const BROWSER_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

/** Query params the real web client appends to www.tiktok.com API calls. */
export function webParams(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    device_platform: "web_pc",
    channel: "tiktok_web",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "en-US",
    browser_platform: "Win32",
    browser_name: "Mozilla",
    browser_online: "true",
    ...extra,
  }).toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TikTokError extends Error {
  code: string;
  constructor(message: string, code = "TikTokError") {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- region / bot detection

/**
 * TikTok answers API calls from blocked regions / datacenter IPs with its HTML web shell
 * instead of JSON (this server's IP is in Hong Kong, where TikTok stopped operating).
 */
const REGION_BLOCK_MARKERS = [
  "discontinued operating tiktok in hong kong",
  "tiktok is not available",
  "not available in your region",
  "service is unavailable in your region",
  "captcha-container",
  "verify-you-are-human",
  "tiktok.com/redirect",
];

/** True when the response looks like the region/bot-block HTML shell. */
export function looksLikeRegionBlock(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("<!doctype html") && !lower.includes("<html")) return false;
  return REGION_BLOCK_MARKERS.some((m) => lower.includes(m)) || (lower.includes("tiktok") && lower.includes("term of use") && !lower.includes("video_token"));
}

/** Parses "http://[user:pass@]host:port" into an undici ProxyAgent, or undefined for "". */
export function parseProxy(proxy: string): ProxyAgent | undefined {
  const value = proxy.trim();
  if (!value) return undefined;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new TikTokError(
      "Proxy format ghalat hai. Aise likhein: http://host:port ya http://user:pass@host:port",
      "bad_proxy",
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TikTokError(
      "Sirf http:// ya https:// proxy support hota hai (socks nahi). Har proxy provider HTTP proxy bhi deta hai.",
      "bad_proxy",
    );
  }
  // WHATWG URL: default port (http:80 / https:443) u.port me KHALI string deta hai,
  // isliye port-80 wale free proxies ghalat "port missing" kehte the. Ab default port khud bhar dete hain.
  const effectivePort = u.port || (u.protocol === "https:" ? "443" : "80");
  if (!u.hostname || !effectivePort) {
    throw new TikTokError("Proxy me host aur port dono hone chahiye: http://host:port", "bad_proxy");
  }
  return new ProxyAgent(value);
}

// ---------------------------------------------------------------- crc32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32hex(buf: Buffer): string {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).toLowerCase().padStart(8, "0");
}

// ---------------------------------------------------------------- http helper

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function headerGet(headers: Record<string, string | string[] | undefined>, name: string): string | string[] | undefined {
  return headers[name];
}

interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Dispatcher.RequestOptions["body"];
  timeoutMs?: number;
  /** Follow redirects manually so Set-Cookie of each hop lands in the jar. */
  followRedirects?: boolean;
}

export class TikTokHttp {
  jar: CookieJar;
  userAgent: string;
  proxyAgent?: ProxyAgent;

  constructor(jar: CookieJar, userAgent: string, proxy?: string | ProxyAgent) {
    this.jar = jar;
    this.userAgent = userAgent;
    this.proxyAgent = proxy instanceof ProxyAgent ? proxy : parseProxy(proxy ?? "");
  }

  /** One request; Set-Cookie of the response is stored in the jar. */
  async raw(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
    const u = new URL(url);
    const isTikTok = u.hostname.toLowerCase().endsWith("tiktok.com");
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      ...(isTikTok ? BROWSER_HEADERS : {}),
      ...(opts.headers ?? {}),
    };
    const cookie = this.jar.header(u);
    if (cookie) headers.cookie = cookie;

    const res = await request(u, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      bodyTimeout: opts.timeoutMs ?? 60000,
      headersTimeout: opts.timeoutMs ?? 60000,
      maxRedirections: 0,
      ...(this.proxyAgent ? { dispatcher: this.proxyAgent as unknown as Dispatcher } : {}),
    });
    const responseHeaders = res.headers as Record<string, string | string[] | undefined>;
    const setCookie = headerGet(responseHeaders, "set-cookie");
    if (setCookie) this.jar.store(u, setCookie);
    const text = await res.body.text();
    res.body.destroy();
    return { status: res.statusCode, headers: responseHeaders, text };
  }

  /** Request with manual redirect following (cookies refreshed between hops). */
  async request(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
    let current = url;
    const follow = opts.followRedirects !== false;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.raw(current, opts);
      if (follow && REDIRECTS.has(res.status)) {
        const loc = headerGet(res.headers, "location");
        const locStr = Array.isArray(loc) ? loc[0] : loc;
        if (locStr) {
          current = new URL(locStr, current).toString();
          if (res.status === 303) {
            opts = { ...opts, method: "GET", body: undefined };
          }
          continue;
        }
      }
      return res;
    }
    throw new TikTokError("Bohat zyada redirects ho gaye (10+).", "redirect_loop");
  }

  async json(url: string, opts: HttpOptions = {}): Promise<Record<string, unknown>> {
    const res = await this.request(url, opts);
    try {
      return JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      throw new TikTokError(
        `TikTok ne JSON ke bajaye HTML bheja (HTTP ${res.status}). Session expire ho chuka ho sakta hai ya TikTok ne request block ki hai.`,
        "non_json",
      );
    }
  }
}

// ---------------------------------------------------------------- caption

export interface TextExtra {
  start: number;
  end: number;
  type: 0 | 1;
  user_id: string;
  hashtag_name: string;
  tag_id: string;
}

export interface Caption {
  markup: string;
  textExtra: TextExtra[];
}

const TOKEN_RE = /#([\p{L}\p{N}_]+)|@([A-Za-z0-9_.]*[A-Za-z0-9_])/gu;

/** Turns #hashtags / @mentions into TikTok's markup_text + text_extra (clickable tags). */
export function buildCaption(text: string): Caption {
  const markup: string[] = [];
  const textExtra: TextExtra[] = [];
  let last = 0;
  let nextId = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    const token = match[0];
    const hashtag = match[1];
    markup.push(text.slice(last, start));
    const end = start + token.length;
    if (hashtag) {
      textExtra.push({
        start,
        end,
        type: 1,
        user_id: "",
        hashtag_name: hashtag,
        tag_id: String(nextId),
      });
      markup.push(`<h id="${nextId}">${token}</h>`);
      nextId++;
    } else {
      // Mentions are left as plain text (no user lookup, keeps posting reliable).
      markup.push(token);
    }
    last = end;
  }
  markup.push(text.slice(last));
  return { markup: markup.join(""), textExtra };
}

/** Parses user hashtag input ("fyp, viral" / "#fyp #viral") and appends them to the title. */
export function parseHashtags(input: string): string[] {
  return input
    .split(/[\s,،\n]+/)
    .map((t) => t.trim().replace(/^#+/, ""))
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((t) => t.length > 0 && t.length <= 50);
}

export function buildCaptionText(title: string, hashtags: string[] | string): string {
  let text = title.trim();
  const tags = Array.isArray(hashtags) ? hashtags : parseHashtags(hashtags);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(t);
    }
  }
  for (const t of unique) {
    if (!new RegExp(`#${t}(?=\\s|$)`, "i").test(text)) text += ` #${t}`;
  }
  if (text.length > MAX_CAPTION_LENGTH) text = text.slice(0, MAX_CAPTION_LENGTH);
  return text;
}

// ---------------------------------------------------------------- session

export interface SessionCheck {
  ok: boolean;
  userId: string;
  username: string;
  nickname: string;
  avatarUrl: string;
  rawError?: string;
}

/**
 * Verifies the cookie session is valid for uploads + fetches basic account info.
 * Throws TikTokError with a precise code so the UI can show the right guidance.
 */
export async function checkSession(http: TikTokHttp): Promise<SessionCheck> {
  const out: SessionCheck = { ok: false, userId: "", username: "", nickname: "", avatarUrl: "" };

  // 1. The real gate: TikTok must hand out upload credentials for this session.
  const authRes = await http.request(`${TT}/api/v1/video/upload/auth/?${webParams({ aid: String(AID) })}`, {
    timeoutMs: 45000,
    headers: { referer: `${TT}/upload?lang=en`, origin: TT },
  });

  if (looksLikeRegionBlock(authRes.text)) {
    throw new TikTokError(
      "TikTok ne request block kar di: ye server TikTok ke blocked region (Hong Kong) mein hai aur TikTok wahan service band kar chuka hai. PAKKA HAL (free aur permanent): bot ke page par sab se upar 'Pakka Hal: Direct Post (Userscript)' card use karein - us me video aap ke phone se seedha TikTok par jati hai, cookies ya proxy ki zaroorat hi nahi.",
      "region_blocked",
    );
  }
  if (authRes.status !== 200 || !authRes.text.includes("video_token_v5")) {
    // A JSON error (e.g. "please login first") means the request got through but the session is bad.
    const isJson = authRes.text.trimStart().startsWith("{");
    if (isJson) {
      // Diagnose: TikTok ka asli jawab dikhao taake pata chale session mara ya IP se reject hua.
      let detail = "";
      try {
        const j = JSON.parse(authRes.text) as Record<string, unknown>;
        const raw =
          (j.message as string | undefined) ??
          ((j.error as Record<string, unknown> | undefined)?.message as string | undefined) ??
          "";
        detail = String(raw).replace(/\s+/g, " ").trim().slice(0, 80);
      } catch {
        /* keep empty */
      }
      throw new TikTokError(
        `TikTok ne cookies accept nahi ki (session expire/block${detail ? ` - TikTok: "${detail}"` : ""}). Wajah: free datacenter proxies ka IP TikTok ko shakhi lagta hai aur wo session reject kar deta hai. PAKKA HAL (free aur permanent): bot ke page par sab se upar 'Pakka Hal: Direct Post (Userscript)' card use karein - video aap ke phone se seedha TikTok par jati hai, cookies ya proxy ki zaroorat hi nahi.`,
        "session_invalid",
      );
    }
    throw new TikTokError(
      `TikTok ne upload API ka jawab JSON ke bajaye kuch aur diya (HTTP ${authRes.status}). Ho sakta hai TikTok ka bot-check laga ho - thodi der baad ya behtar proxy ke sath try karein.`,
      "html_response",
    );
  }

  // 2. Best-effort account info for display.
  try {
    const info = await http.json(
      `${TT}/passport/web/account/info/?aid=${AID}&device_platform=web&channel=tiktok_web&app_name=tiktok_web`,
      { timeoutMs: 30000 },
    );
    const data = (info.data ?? {}) as Record<string, unknown>;
    out.userId = String(data.user_id_str ?? data.user_id ?? "");
    out.username = String(data.username ?? data.name ?? data.origin_name ?? "");
    out.nickname = String(data.nickname ?? data.username ?? data.name ?? "");
    const avatar = (data.avatar_url as string | undefined) ?? (data.avatar_medium as { url_list?: string[] } | undefined)?.url_list?.[0];
    if (typeof avatar === "string") out.avatarUrl = avatar;
  } catch {
    /* account info is optional; upload/auth already proved the session */
  }

  out.ok = true;
  return out;
}

// ---------------------------------------------------------------- upload + publish

export interface TransferProgress {
  uploaded: number;
  total: number;
}

const randomCreationId = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
  let id = "";
  for (let i = 0; i < 21; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
};

export interface TransferResult {
  videoId: string;
}

/** Sends the video file to TikTok's storage (VOD). Returns TikTok's video_id. */
export async function transferVideo(
  http: TikTokHttp,
  videoPath: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<TransferResult> {
  const fileSize = statSync(videoPath).size;
  if (fileSize === 0) throw new TikTokError("Video file khali hai (0 bytes).", "empty_file");

  // 1. Ask TikTok for upload credentials for this session.
  const authJson = await http.json(`${TT}/api/v1/video/upload/auth/?${webParams({ aid: String(AID) })}`, {
    timeoutMs: 30000,
    headers: { referer: `${TT}/upload?lang=en`, origin: TT },
  });
  const token = (authJson as { video_token_v5?: Record<string, string> }).video_token_v5;
  if (!token?.access_key_id || !token?.secret_acess_key) {
    throw new TikTokError(
      "TikTok ne upload credentials nahi diye - session invalid hai. Cookies dobara paste karein.",
      "no_upload_token",
    );
  }
  const aws: AwsCredentials = {
    accessKeyId: token.access_key_id,
    secretAccessKey: token.secret_acess_key,
    sessionToken: token.session_token,
  };

  // 2. Reserve a slot on TikTok's VOD storage.
  const applyUrl =
    `${TT}/top/v1?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=tiktok` +
    `&FileType=video&IsInner=1&FileSize=${fileSize}&s=g158iqx8434`;
  const applySigned = signV4({ method: "GET", url: applyUrl, headers: {} }, aws, {
    region: AWS_REGION,
    service: "vod",
  });
  const applyRes = await http.raw(applyUrl, { headers: applySigned, timeoutMs: 60000 });
  let applyJson: Record<string, unknown>;
  try {
    applyJson = JSON.parse(applyRes.text) as Record<string, unknown>;
  } catch {
    throw new TikTokError(`ApplyUpload fail (HTTP ${applyRes.status}).`, "apply_failed");
  }
  const node = (
    (applyJson.Result as { InnerUploadAddress?: { UploadNodes?: Array<Record<string, unknown>> } } | undefined)
      ?.InnerUploadAddress?.UploadNodes ?? []
  )[0];
  if (!node) {
    throw new TikTokError("ApplyUpload ka response unexpected hai. Session/datacenter cookie check karein.", "apply_bad_response");
  }
  const videoId = String(node.Vid);
  const store = (node.StoreInfos as Array<Record<string, unknown>>)[0];
  const storeUri = String(store.StoreUri);
  const storeAuth = String(store.Auth);
  const uploadHost = String(node.UploadHost);
  const sessionKey = String(node.SessionKey);

  // 3. Upload the file in 5 MiB parts (with CRC32 per part, like the web client).
  const uploadId = randomUUID();
  const crcs: string[] = [];
  const stream = createReadStream(videoPath, { highWaterMark: CHUNK_SIZE });
  let part = 0;
  let uploaded = 0;
  for await (const chunk of stream) {
    part += 1;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    const crc = crc32hex(buf);
    crcs.push(crc);
    const partUrl = `https://${uploadHost}/${storeUri}?partNumber=${part}&uploadID=${uploadId}&phase=transfer`;
    const res = await http.raw(partUrl, {
      method: "POST",
      headers: {
        authorization: storeAuth,
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="undefined"',
        "content-crc32": crc,
      },
      body: buf,
      timeoutMs: 300000,
      followRedirects: false,
    });
    if (res.status !== 200) {
      throw new TikTokError(`Video part ${part} upload fail (HTTP ${res.status}).`, "part_failed");
    }
    uploaded += buf.length;
    onProgress?.({ uploaded, total: fileSize });
    // Small human-like pause between parts (free proxies + TikTok rate limits like this).
    if (uploaded < fileSize) await sleep(60 + Math.round(Math.random() * 120));
  }
  if (!crcs.length) throw new TikTokError("Video file khali hai.", "empty_file");

  // 4. Tell the storage host the multipart upload is complete (no TikTok cookies here,
  //    exactly like the web client does).
  const finishUrl = `https://${uploadHost}/${storeUri}?uploadID=${uploadId}&phase=finish&uploadmode=part`;
  const finishRes = await http.raw(finishUrl, {
    method: "POST",
    headers: { authorization: storeAuth, "content-type": "text/plain;charset=UTF-8" },
    body: crcs.map((c, i) => `${i + 1}:${c}`).join(","),
    timeoutMs: 120000,
    followRedirects: false,
  });
  if (finishRes.status !== 200) {
    throw new TikTokError(`Upload finish fail (HTTP ${finishRes.status}).`, "finish_failed");
  }

  // 5. Commit the uploaded file on TikTok's VOD service.
  const commitUrl = `${TT}/top/v1?Action=CommitUploadInner&Version=2020-11-19&SpaceName=tiktok`;
  const commitBody = JSON.stringify({ SessionKey: sessionKey, Functions: [{ name: "GetMeta" }] });
  const commitSigned = signV4({ method: "POST", url: commitUrl, headers: {}, body: commitBody }, aws, {
    region: AWS_REGION,
    service: "vod",
  });
  const commitRes = await http.raw(commitUrl, { method: "POST", headers: commitSigned, body: commitBody, timeoutMs: 60000 });
  if (commitRes.status !== 200) {
    throw new TikTokError(`Commit upload fail (HTTP ${commitRes.status}).`, "commit_failed");
  }

  // 6. Small refresh request, like the web client does before publishing.
  await http.raw(TT, { method: "HEAD", headers: { "user-agent": http.userAgent }, timeoutMs: 30000 }).catch(() => undefined);

  return { videoId };
}

export interface PublishResult {
  statusCode: number;
  statusMsg: string;
  response: Record<string, unknown>;
}

export interface PublishOptions {
  creationId: string;
  videoId: string;
  captionText: string;
  visibility: "0" | "1"; // 0 public, 1 private
}

/** Creates the draft project TikTok's new uploader needs. */
export async function createProject(http: TikTokHttp): Promise<string> {
  const creationId = randomCreationId();
  const data = await http.json(
    `${TT}/api/v1/web/project/create/?${webParams({ aid: String(AID), creation_id: creationId, type: "1" })}`,
    {
      method: "POST",
      timeoutMs: 60000,
      headers: { referer: `${TT}/upload?lang=en`, origin: TT },
    },
  );
  if (!data.project) {
    throw new TikTokError(
      "TikTok ne project create nahi hone diya. Session expire ho chuka ho sakta hai ya tt-target-idc cookie ghalat hai.",
      "project_failed",
    );
  }
  return creationId;
}

/** Publishes the uploaded video with caption + hashtags (request is signed via headless chromium). */
export async function publishVideo(http: TikTokHttp, opts: PublishOptions): Promise<PublishResult> {
  const caption = buildCaption(opts.captionText);
  const datacenter = http.jar.get("tt-target-idc") ?? DEFAULT_DATACENTER;
  if (!http.jar.get("tt-target-idc")) {
    http.jar.set("tt-target-idc", datacenter);
  }

  const feature = {
    geofencing_regions: [],
    playlist_name: "",
    playlist_id: "",
    tcm_params: '{"commerce_toggle_info":{}}',
    sound_exemption: 0,
    anchors: [],
    vedit_common_info: { draft: "", video_id: opts.videoId },
    privacy_setting_info: {
      visibility_type: Number(opts.visibility),
      allow_duet: 0,
      allow_stitch: 0,
      allow_comment: 1,
    },
  };
  const payload = {
    post_common_info: { creation_id: opts.creationId, enter_post_page_from: 1, post_type: 3 },
    feature_common_info_list: [feature],
    single_post_req_list: [
      {
        batch_index: 0,
        video_id: opts.videoId,
        is_long_video: 0,
        single_post_feature_info: {
          text: opts.captionText,
          text_extra: caption.textExtra,
          markup_text: caption.markup,
          music_info: {},
          poster_delay: 0,
        },
      },
    ],
  };

  const msToken = http.jar.get("msToken") ?? "";
  const verifyFp = http.jar.get("s_v_web_id") ?? "";
  const query = webParams({
    app_name: "tiktok_web",
    aid: String(AID),
    msToken,
    ...(verifyFp ? { verifyFp, s_v_web_id: verifyFp } : {}),
  });
  const toSign = `${TT}/api/v1/web/project/post/?${query}`;
  const sig = await signer.sign(toSign, http.userAgent, verifyFp || undefined);

  const params = new URLSearchParams({
    app_name: "tiktok_web",
    channel: "tiktok_web",
    device_platform: "web",
    aid: String(AID),
    msToken,
    "X-Bogus": sig.xBogus,
    _signature: sig.signature,
  });

  const res = await http.request(`${TT}/tiktok/web/project/post/v1/?${params}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": http.userAgent,
      origin: TT,
      referer: `${TT}/`,
    },
    body: JSON.stringify(payload),
    timeoutMs: 120000,
    followRedirects: false,
  });

  if (res.status !== 200) {
    throw new TikTokError(
      `Publish request fail (HTTP ${res.status}). TikTok ne block kiya ho sakta hai - thodi der baad try karein.`,
      "publish_http",
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    throw new TikTokError("Publish ka response JSON nahi tha - video post ho bhi sakta hai ya nahi bhi. TikTok app me check karein.", "publish_uncertain");
  }
  const statusCode = Number(data.status_code ?? -1);
  if (statusCode !== 0) {
    throw new TikTokError(
      `TikTok ne post reject kar diya: ${String(data.status_msg ?? "unknown error")} (status_code=${statusCode})`,
      "publish_rejected",
    );
  }
  return { statusCode, statusMsg: String(data.status_msg ?? ""), response: data };
}
