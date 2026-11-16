/**
 * Background runner for upload jobs: loads the stored cookie session, replays the whole
 * TikTok upload flow and keeps the UploadJob row updated so the UI can poll progress.
 */
import { unlink } from "node:fs/promises";
import { db } from "@/lib/db";
import { CookieJar } from "./cookie-jar";
import {
  isConnectionError,
  penalizeProxy,
  pickLiveProxy,
  probeProxy,
  refreshPoolOnce,
} from "./proxy-pool";
import {
  DEFAULT_UA,
  TikTokError,
  TikTokHttp,
  buildCaptionText,
  checkSession,
  createProject,
  parseHashtags,
  publishVideo,
  transferVideo,
} from "./client";
import { proxyMode } from "./mode";

export const UPLOAD_DIR = "/tmp/tiktok-uploads";

type JobRow = {
  id: string;
  sessionId: string;
  videoPath: string;
  title: string;
  hashtags: string;
  visibility: string;
};

async function updateJob(id: string, data: Partial<{ status: string; stage: string; progress: number; message: string; error: string; resultJson: string }>) {
  await db.uploadJob.update({ where: { id }, data });
}

/** Free proxies die often - these errors are worth retrying with a different proxy.
 *  NOTE: publish-stage errors are deliberately NOT retryable (a retry could post the video twice).
 *  session_invalid only ever comes from the validate stage (checkSession, before anything is
 *  uploaded), so retrying it with a different proxy can never double-post.
 */
const RETRYABLE_CODES = new Set([
  "session_invalid",
  "part_failed",
  "apply_failed",
  "commit_failed",
  "finish_failed",
  "non_json",
  "html_response",
  "apply_bad_response",
  "project_failed",
  "redirect_loop",
  "network",
]);

function loadJar(cookiesJson: string): CookieJar {
  const jar = new CookieJar();
  for (const c of JSON.parse(cookiesJson) as Array<{ name: string; value: string; domain?: string; path?: string }>) {
    jar.set(c.name, c.value, { domain: c.domain ?? ".tiktok.com", path: c.path ?? "/" });
  }
  return jar;
}

async function attemptUpload(job: JobRow, proxy: string): Promise<void> {
  const session = await db.tikTokSession.findUnique({ where: { id: job.sessionId } });
  if (!session) throw new TikTokError("TikTok session delete ho chuki hai. Dobara cookie login karein.", "no_session");

  const http = new TikTokHttp(loadJar(session.cookies), session.userAgent || DEFAULT_UA, proxy);

  await updateJob(job.id, { status: "validating", stage: "validating", progress: 5, message: "TikTok session check ho raha hai..." });
  const check = await checkSession(http); // throws TikTokError with precise message
  if (!check.ok) {
    throw new TikTokError(
      "Cookies ab valid nahi hain (session expire ya block). Kiwi browser se nayi cookies nikal kar dobara login karein.",
      "session_invalid",
    );
  }

  await updateJob(job.id, { status: "creating_project", stage: "creating_project", progress: 10, message: "TikTok par draft project ban raha hai..." });
  const creationId = await createProject(http);

  await updateJob(job.id, { status: "uploading", stage: "uploading", progress: 15, message: "Video TikTok ke storage par upload ho raha hai..." });
  const { videoId } = await transferVideo(http, job.videoPath, ({ uploaded, total }) => {
    const pct = 15 + Math.round((uploaded / total) * 65); // 15% .. 80%
    void updateJob(job.id, {
      progress: Math.min(pct, 80),
      message: `Video upload ho raha hai... ${Math.round((uploaded / total) * 100)}% (${(uploaded / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`,
    }).catch(() => undefined);
  });

  await updateJob(job.id, { status: "finishing", stage: "finishing", progress: 85, message: "Video process ho raha hai (commit)..." });

  await updateJob(job.id, { status: "publishing", stage: "publishing", progress: 92, message: "TikTok par publish ho raha hai (title + hashtags ke sath)..." });
  const captionText = buildCaptionText(job.title, parseHashtags(job.hashtags));
  const result = await publishVideo(http, {
    creationId,
    videoId,
    captionText,
    visibility: job.visibility === "1" ? "1" : "0",
  });

  await updateJob(job.id, {
    status: "done",
    stage: "done",
    progress: 100,
    message: "Mubarak ho! Video TikTok par post ho gaya.",
    resultJson: JSON.stringify({ ...result, captionText, videoId }),
    error: "",
  });
}

// (runUploadJob neeche proxyLabel helper ke baad define hai)

/** "http://user:pass@host:port" -> "host:port" (credentials kabhi UI/log me nahi jaate). */
function proxyLabel(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.hostname}:${port}`;
  } catch {
    return proxyUrl;
  }
}

export async function runUploadJob(job: JobRow): Promise<void> {
  try {
    const session = await db.tikTokSession.findUnique({ where: { id: job.sessionId } });
    if (!session) throw new TikTokError("TikTok session delete ho chuki hai. Dobara cookie login karein.", "no_session");

    const manualProxy = Boolean(session.proxy && session.proxy.includes("@"));

    // ---------- DIRECT mode (Render/VPS jaisa TikTok-supported region): server ka apna
    // stable IP, koi proxy nahi. Ek network-error retry kaafi hai.
    if (!manualProxy && proxyMode() === "direct") {
      await updateJob(job.id, {
        status: "validating",
        stage: "validating",
        progress: 5,
        message: "Server ka apna stable IP use ho raha hai (direct connection, koi proxy nahi)...",
      }).catch(() => undefined);
      try {
        await attemptUpload(job, "");
        return;
      } catch (err) {
        if (err instanceof TikTokError || !isConnectionError(err)) throw err;
        await updateJob(job.id, { message: "Network hiccup - ek dafa dobara try ho raha hai..." }).catch(() => undefined);
        await attemptUpload(job, "");
        return;
      }
    }

    // ---------- Manual proxy: single path, koi failover nahi. Sirf pehle quick probe
    // taake dead proxy par 45-60s ke request timeouts barbaad na hon.
    if (manualProxy) {
      await updateJob(job.id, {
        status: "validating",
        stage: "validating",
        progress: 5,
        message: `Aap ka proxy (${proxyLabel(session.proxy ?? "")}) test ho raha hai...`,
      }).catch(() => undefined);
      if (!(await probeProxy(session.proxy ?? "", 12000))) {
        throw new TikTokError(
          `Aap ka manual proxy (${proxyLabel(session.proxy ?? "")}) connect nahi ho raha - offline/dead hai ya port ghalat hai. Proxy dobara check karein ya doosra proxy lagayein.`,
          "bad_proxy",
        );
      }
      await attemptUpload(job, session.proxy ?? ""); // raw network error = fail fast (retry faila bekaar)
      return;
    }

    // ---------- Pool flow: har attempt se pehle LIVE proxy probe karke chuno.
    // DB sorting purani validation par bani hoti hai - free proxies beech me mar jaate hain,
    // isliye use se pehle har candidate ka 8s liveness probe zaroori hai.
    const usedHosts = new Set<string>();
    let refreshed = false;
    let proxy = session.proxy ?? "";

    // Remembered proxy (login wala) ko loop se pehle probe karo - mara hua hai to ek poora
    // attempt connect-timeout me barbaad karne ke bajaye turant failover karo.
    await updateJob(job.id, {
      status: "validating",
      stage: "validating",
      progress: 5,
      message: proxy ? "Purana proxy test ho raha hai..." : "Zinda (live) proxy dhoonda ja raha hai...",
    }).catch(() => undefined);
    if (proxy) {
      const alive = await probeProxy(proxy, 8000);
      if (!alive) {
        await penalizeProxy(proxy, 2).catch(() => undefined);
        usedHosts.add(proxyLabel(proxy));
        proxy = "";
      }
    }

    const chooseProxy = async (): Promise<string> => {
      // 1. Purana remembered proxy (login/pichli attempt ka) - agar zinda hai to wahi best hai.
      if (proxy && !usedHosts.has(proxyLabel(proxy))) {
        const alive = await probeProxy(proxy, 8000);
        if (alive) return proxy;
        await penalizeProxy(proxy, 2).catch(() => undefined);
        usedHosts.add(proxyLabel(proxy));
      }
      // 2. Top pool candidates parallel probe; pehla zinda jeet gaya.
      let alt = await pickLiveProxy([...usedHosts]);
      // 3. Pool ke top sab mare hue -> ek baar fresh scan (30-90s) phir probe.
      if (!alt && !refreshed) {
        refreshed = true;
        await updateJob(job.id, {
          message: "Pool ke free proxies down ho gaye hain - fresh proxy list scan ho rahi hai (30-90 second), thoda sabar...",
        }).catch(() => undefined);
        await refreshPoolOnce(160, 32).catch(() => undefined);
        alt = await pickLiveProxy([...usedHosts]);
      }
      if (!alt) {
        throw new TikTokError(
          "Koi bhi free proxy TikTok tak connect nahi ho pa raha (sab down hain). 2-3 minute baad dobara try karein. PAKKA HAL (free aur permanent): bot ke page par sab se upar 'Pakka Hal: Direct Post (Userscript)' card use karein - us me video aap ke phone se seedha TikTok par jati hai, cookies ya proxy ki zaroorat hi nahi.",
          "no_live_proxy",
        );
      }
      return alt.proxyUrl;
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      let current = proxy;
      try {
        if (!current || usedHosts.has(proxyLabel(current))) {
          await updateJob(job.id, {
            message: current ? "Purana proxy mar gaya tha - zinda proxy dhoonda ja raha hai..." : "Zinda (live) proxy dhoonda ja raha hai...",
          }).catch(() => undefined);
          current = await chooseProxy();
          proxy = current;
          await db.tikTokSession.update({ where: { id: job.sessionId }, data: { proxy } }).catch(() => undefined);
        }
        await attemptUpload(job, current);
        return;
      } catch (err) {
        const tikErr = err instanceof TikTokError;
        const retryable = (tikErr && RETRYABLE_CODES.has(err.code)) || (!tikErr && isConnectionError(err));
        if (!retryable || attempt === 3) throw err;
        if (current) {
          await penalizeProxy(current, 2).catch(() => undefined);
          usedHosts.add(proxyLabel(current));
        }
        await updateJob(job.id, {
          message:
            tikErr && err.code === "session_invalid"
              ? `TikTok ne is proxy ke IP se session reject kiya - doosra zinda proxy try ho raha hai (${attempt + 1}/3)...`
              : `Proxy (${current ? proxyLabel(current) : "purana"}) fail ho gaya - doosra zinda proxy try ho raha hai (${attempt + 1}/3)...`,
        }).catch(() => undefined);
        proxy = ""; // loop top par fresh live proxy chunega
      }
    }
  } catch (err) {
    let message: string;
    if (err instanceof TikTokError) {
      message = err.message;
    } else if (err instanceof Error) {
      // Retries khatam hone ke baad ka raw network error - technical lekin friendly.
      message = isConnectionError(err)
        ? `TikTok tak connection nahi ban paya (${err.message.slice(0, 120)}). Dobara try karein - bot fresh live proxy dhoond lega. Bar bar ho raha hai to page par sab se upar 'Pakka Hal: Direct Post (Userscript)' card use karein - free aur permanent, cookies/proxy ki zaroorat nahi.`
        : `Upload fail: ${err.message.slice(0, 200)}`;
    } else {
      message = "Upload fail ho gaya (unknown error).";
    }
    await updateJob(job.id, { status: "failed", stage: "failed", message: "", error: message }).catch(() => undefined);
  } finally {
    // Best effort cleanup of the temp video.
    void unlink(job.videoPath).catch(() => undefined);
  }
}

/** Kicks off a job in the background (never awaited by the API route). */
export function startUploadJob(job: JobRow): void {
  void runUploadJob(job);
}
