"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  CloudUpload,
  Film,
  Loader2,
  LogOut,
  Music2,
  RefreshCw,
  Send,
  Tag,
  Trash2,
  Type,
} from "lucide-react";
import { DirectPostCard } from "@/components/direct-post-card";
import { RenderDeployCard } from "@/components/render-deploy-card";

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

interface JobStatus {
  id: string;
  status: string;
  stage: string;
  progress: number;
  message: string;
  error: string;
  title: string;
  result: Record<string, unknown> | null;
}

const QUICK_TAGS = ["fyp", "foryou", "viral", "trending", "pakistan", "reels", "funny", "islamic", "dailyvlog"];

/** Chunk size < 1 MB: the preview gateway rejects bigger request bodies with an HTML error page. */
const UPLOAD_CHUNK = 768 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parses an API response; on HTML/gateway errors throws a readable Roman-Urdu message. */
async function parseApiJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const clean = text
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    throw new Error(clean ? `Server error (HTTP ${res.status}): ${clean}` : `Server se HTML error mila (HTTP ${res.status}). Thodi der baad dobara try karein.`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ---------------------------------------------------------------- bot session (iframe-safe) ----
 * Chat preview iframe me browser SameSite cookie block kar deta hai — is liye login ke baad
 * bhi Post par "Session expire" aa raha tha. Hal: server se milne wala sid localStorage me
 * rakhte hain aur HAR API call par `x-tt-sid` header me bhejte hain (cookie ke ilawa).
 * -------------------------------------------------------------------------------------------- */
const SID_STORAGE_KEY = "tt_bot_sid";

function loadStoredSid(): string {
  try {
    return window.localStorage.getItem(SID_STORAGE_KEY) ?? "";
  } catch {
    return ""; // localStorage block ho to sirf memory chalegi
  }
}

function storeSid(sid: string) {
  try {
    if (sid) window.localStorage.setItem(SID_STORAGE_KEY, sid);
    else window.localStorage.removeItem(SID_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export default function Home() {
  // ---------- auth state ----------
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [cookieText, setCookieText] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [poolHealthy, setPoolHealthy] = useState<number | null>(null);
  const [poolMode, setPoolMode] = useState<"direct" | "pool" | null>(null);
  const [poolRefreshing, setPoolRefreshing] = useState(false);

  const loadPool = useCallback(async () => {
    try {
      const r = await fetch("/api/proxy");
      const d = (await r.json()) as { ok: boolean; healthy?: number; mode?: "direct" | "pool" };
      setPoolHealthy(d.ok && typeof d.healthy === "number" ? d.healthy : null);
      setPoolMode(d.mode ?? "pool");
    } catch {
      setPoolHealthy(null);
    }
  }, []);

  const refreshPoolNow = useCallback(async () => {
    setPoolRefreshing(true);
    setLoginError("");
    try {
      const r = await fetch("/api/proxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ max: 220 }) });
      const d = (await r.json()) as { ok: boolean; healthy?: number; error?: string };
      setPoolHealthy(typeof d.healthy === "number" ? d.healthy : 0);
      if (!d.ok && d.error) setLoginError(d.error);
    } catch {
      setLoginError("Proxy pool refresh nahi ho saka.");
    } finally {
      setPoolRefreshing(false);
    }
  }, []);

  // ---------- upload state ----------
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState("");
  const [title, setTitle] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [visibility, setVisibility] = useState("0");
  const [postLoading, setPostLoading] = useState(false);
  const [postError, setPostError] = useState("");
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<"sending" | "processing" | "">("");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ caption: string; videoId?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bot ka session id: har API call par x-tt-sid header me bheja jata hai (iframe-safe).
  const sidRef = useRef<string>(loadStoredSid());
  const apiHeaders = useCallback((extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = { ...extra };
    if (sidRef.current) h["x-tt-sid"] = sidRef.current;
    return h;
  }, []);

  // ---------- load session on mount ----------
  useEffect(() => {
    fetch("/api/auth", { headers: apiHeaders() })
      .then((r) => r.json())
      .then((d: { authenticated: boolean; info: SessionInfo | null }) => {
        setSession(d.info);
        if (!d.authenticated) {
          sidRef.current = "";
          storeSid("");
        }
      })
      .catch(() => setSession(null))
      .finally(() => setAuthLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // pool health is only relevant on the login screen
  useEffect(() => {
    if (!session?.authenticated) void loadPool();
  }, [session?.authenticated, loadPool]);

  // cleanup preview url
  useEffect(() => {
    return () => {
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    };
  }, [videoPreviewUrl]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // ---------- login ----------
  const handleLogin = async () => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookies: cookieText, proxy: proxyInput.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; info?: SessionInfo; sid?: string };
      if (data.ok && data.info) {
        // sid ko save karo: preview iframe me cookie block ho to bhi upload chalega.
        sidRef.current = data.sid ?? "";
        storeSid(sidRef.current);
        setSession(data.info);
        setCookieText("");
      } else {
        setLoginError(data.error ?? "Login fail ho gaya.");
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth", { method: "DELETE", headers: apiHeaders() }).catch(() => undefined);
    sidRef.current = "";
    storeSid("");
    setSession(null);
    setJob(null);
    setDoneInfo(null);
    setPostError("");
  };

  // ---------- video pick ----------
  const pickVideo = (file: File | null) => {
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    if (!file) {
      setVideoFile(null);
      setVideoPreviewUrl("");
      return;
    }
    setVideoFile(file);
    setVideoPreviewUrl(URL.createObjectURL(file));
  };

  const addQuickTag = (tag: string) => {
    setHashtags((prev) => {
      const t = prev.trim();
      if (new RegExp(`(^|\\s)#${tag}(?=\\s|$)`, "i").test(t)) return prev;
      return t ? `${t.replace(/#*$/, "")} #${tag}`.trim() : `#${tag}`;
    });
  };

  // ---------- post ----------
  const handlePost = async () => {
    if (!videoFile || !title.trim()) return;
    setPostLoading(true);
    setPostError("");
    setJob(null);
    setDoneInfo(null);
    setUploadPct(0);
    setUploadPhase("sending");
    stopPolling();
    try {
      // 1. INIT: reserve a job row on the server.
      const initRes = await fetch("/api/upload", {
        method: "POST",
        headers: apiHeaders({
          "x-title": encodeURIComponent(title.trim()),
          "x-hashtags": encodeURIComponent(hashtags.trim()),
          "x-visibility": visibility,
          "x-file-name": encodeURIComponent(videoFile.name),
          "x-file-size": String(videoFile.size),
        }),
      });
      const initData = (await parseApiJson(initRes)) as { ok: boolean; jobId?: string; error?: string };
      if (!initData.ok || !initData.jobId) {
        if (initRes.status === 401) {
          setSession(null);
          setPostError("Session expire ho gaya. Dobara cookies paste kar ke login karein.");
        } else {
          setPostError(initData.error ?? "Upload shuru nahi ho saka.");
        }
        setUploadPhase("");
        setPostLoading(false);
        return;
      }
      const jobId = initData.jobId;

      // 2. CHUNKS: send the video in small pieces (gateway-safe), each with retry.
      const total = videoFile.size;
      let sent = 0;
      while (sent < total) {
        const end = Math.min(sent + UPLOAD_CHUNK, total);
        const blob = videoFile.slice(sent, end);
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetch(`/api/upload/${jobId}/chunk`, {
              method: "POST",
              headers: apiHeaders({ "x-offset": String(sent), "content-type": "application/octet-stream" }),
              body: blob,
            });
            const d = (await parseApiJson(r)) as { ok: boolean; error?: string; received?: number };
            if (!d.ok) throw new Error(d.error ?? "Chunk accept nahi hua");
            sent = typeof d.received === "number" ? d.received : end;
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            await sleep(1200 * (attempt + 1)); // small pause between retries
          }
        }
        if (lastErr) throw lastErr;
        setUploadPct(Math.round((sent / total) * 100));
      }

      // 3. FINISH: server verifies the file and starts the TikTok job.
      setUploadPhase("processing");
      const finRes = await fetch(`/api/upload/${jobId}/finish`, { method: "POST", headers: apiHeaders() });
      const finData = (await parseApiJson(finRes)) as { ok: boolean; jobId?: string; error?: string };
      if (!finData.ok || !finData.jobId) {
        if (finRes.status === 401) {
          setSession(null);
          setPostError("Session expire ho gaya. Dobara cookies paste kar ke login karein.");
        } else {
          setPostError(finData.error ?? "Upload finish nahi ho saka.");
        }
        setUploadPhase("");
        setPostLoading(false);
        return;
      }

      // 4. Poll TikTok job progress
      const pollJobId = finData.jobId;
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/upload/${pollJobId}`);
          const d = (await parseApiJson(r)) as { ok: boolean; job?: JobStatus };
          if (d.ok && d.job) {
            setUploadPhase("");
            setJob(d.job);
            if (d.job.status === "done") {
              stopPolling();
              const caption = (d.job.result?.captionText as string) ?? d.job.title;
              const videoId = d.job.result?.videoId as string | undefined;
              setDoneInfo({ caption, videoId });
              setPostLoading(false);
              setVideoFile(null);
              setVideoPreviewUrl("");
              setTitle("");
              setHashtags("");
            } else if (d.job.status === "failed") {
              stopPolling();
              setPostError(d.job.error || "Post fail ho gaya.");
              setPostLoading(false);
            }
          }
        } catch {
          /* keep polling; transient network hiccups */
        }
      }, 1500);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "Video upload fail ho gaya.");
      setUploadPhase("");
      setPostLoading(false);
    }
  };

  const retryPoll = () => {
    setPostError("");
    setJob(null);
  };

  const canPost = Boolean(videoFile && title.trim() && session?.authenticated && !postLoading);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-600 flex items-center justify-center shadow-lg shadow-rose-600/20">
              <Music2 className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">TikTok Auto Post Bot</h1>
              <p className="text-xs text-zinc-400">Cookie login &rarr; video + hashtags &rarr; automatic post</p>
            </div>
          </div>
          {session?.authenticated && (
            <Button variant="outline" size="sm" onClick={handleLogout} className="border-zinc-700 hover:bg-zinc-800">
              <LogOut className="w-4 h-4 mr-1.5" aria-hidden="true" />
              Logout
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* ---------- RENDER DEPLOYMENT: free cloud server, direct mode (stable IP) ---------- */}
        <RenderDeployCard />

        {/* ---------- PAKKA HAL: Direct Post (userscript) — login/cookies ke baghair, 100% guaranteed backup ---------- */}
        <DirectPostCard />

        {authLoading ? (
          <Card className="bg-zinc-900 border-zinc-800">
            <CardContent className="p-8 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-rose-500" aria-hidden="true" />
            </CardContent>
          </Card>
        ) : (
          <>
            {/* ---------- STEP 1: LOGIN ---------- */}
            {!session?.authenticated ? (
              <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-white">
                    <span className="w-7 h-7 rounded-full bg-rose-600 text-white text-sm font-bold flex items-center justify-center">1</span>
                    TikTok Login (Cookies Paste Karo)
                    <Badge variant="secondary" className="bg-zinc-800 text-zinc-300 border border-zinc-700 text-[11px]">
                      Backup mode
                    </Badge>
                  </CardTitle>
                  <CardDescription className="text-zinc-400">
                    Cookie wala server mode (backup). Bar bar &ldquo;session invalid&rdquo; aa raha hai to sab se upar wala Pakka Hal: Direct Post card use karein &mdash; wo mode bina cookies ke phone se seedha post karta hai.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Collapsible className="border border-zinc-800 rounded-lg">
                    <CollapsibleTrigger className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium hover:bg-zinc-800/50 rounded-lg">
                      <span className="flex items-center gap-2">
                        <ClipboardPaste className="w-4 h-4 text-rose-500" aria-hidden="true" />
                        Cookies kaise nikalein? (Kiwi browser)
                      </span>
                      <ChevronDown className="w-4 h-4 text-zinc-500" aria-hidden="true" />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ol className="px-4 pb-4 pt-1 text-sm text-zinc-300 space-y-2 list-decimal list-inside">
                        <li>Kiwi browser me <span className="text-rose-400">tiktok.com</span> kholo aur apni TikTok ID se login karo.</li>
                        <li>Kiwi browser me <span className="text-rose-400">Cookie Editor</span> extension install karo (Chrome Web Store se).</li>
                        <li>tiktok.com ke tab me Cookie Editor icon kholo aur <span className="text-rose-400">Export &rarr; Export JSON</span> dabao (JSON copy ho jayega).</li>
                        <li>Wo JSON neeche wale box me paste karo aur <span className="text-rose-400">Login</span> button dabao.</li>
                      </ol>
                    </CollapsibleContent>
                  </Collapsible>

                  <div className="space-y-2">
                    <Label htmlFor="cookies" className="text-zinc-300 block">
                      TikTok Cookies (JSON ya name=value format)
                    </Label>
                    <Textarea
                      id="cookies"
                      placeholder={'[{"name": "sessionid", "value": "...", "domain": ".tiktok.com"}, ...]'}
                      value={cookieText}
                      onChange={(e) => setCookieText(e.target.value)}
                      className="min-h-32 font-mono text-xs bg-zinc-950 border-zinc-800 text-zinc-200 placeholder:text-zinc-600"
                      aria-label="TikTok cookies"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="proxy" className="text-zinc-300 block">
                      Apna Proxy (optional - behtar hai agar ho)
                    </Label>
                    <Input
                      id="proxy"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      placeholder="http://host:port ya http://user:pass@host:port"
                      value={proxyInput}
                      onChange={(e) => setProxyInput(e.target.value)}
                      className="font-mono text-xs bg-zinc-950 border-zinc-800 text-zinc-200 placeholder:text-zinc-600"
                      aria-label="Apna proxy"
                    />
                    <p className="text-[11px] text-zinc-500">
                      Khali chhoro to bot free proxy use karega. Lekin free datacenter IPs par TikTok session aksar invalidate kar deta hai &mdash; agar cookie login bar bar fail ho to sab se upar wale <span className="text-emerald-400 font-medium">Pakka Hal: Direct Post (Userscript)</span> card ka use karein: us me cookies aur proxy ki zaroorat hi nahi.
                    </p>
                  </div>

                  {loginError && (
                    <Alert variant="destructive" className="border-rose-800 bg-rose-950/50 text-rose-200">
                      <CircleAlert className="w-4 h-4" aria-hidden="true" />
                      <AlertTitle>Login fail</AlertTitle>
                      <AlertDescription>{loginError}</AlertDescription>
                    </Alert>
                  )}

                  {poolMode === "direct" ? (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />
                      Direct mode: server ka apna stable IP use ho raha hai (koi free proxy nahi) - login seedha TikTok se hoga.
                    </div>
                  ) : (
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                    <span className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${poolHealthy && poolHealthy > 0 ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden="true" />
                      {poolHealthy === null
                        ? "Proxy pool check ho raha hai..."
                        : poolHealthy > 0
                          ? `Free proxy pool: ${poolHealthy} healthy proxies - login khud sab se behtar uthayega`
                          : "Proxy pool khali hai - Refresh dabayein ya 1-2 min baad try karein"}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={refreshPoolNow}
                      disabled={poolRefreshing}
                      className="h-7 px-2 text-xs text-zinc-400 hover:text-rose-400 hover:bg-zinc-800"
                    >
                      {poolRefreshing ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                      )}
                      Pool Refresh
                    </Button>
                  </div>
                  )}

                  <Button
                    onClick={handleLogin}
                    disabled={loginLoading || !cookieText.trim()}
                    className="w-full h-11 bg-rose-600 hover:bg-rose-700 text-white font-semibold"
                  >
                    {loginLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                        Proxies + cookies check ho rahe hain... (30 sec - 5 min, page band na karein)
                      </>
                    ) : (
                      "Login / Verify Karo"
                    )}
                  </Button>

                  <p className="text-xs text-zinc-500">
                    Login ke waqt bot <span className="text-zinc-300">kai free proxies khud try karta hai</span> - ek proxy mare to doosra khud chun leta hai. Sirf <span className="text-zinc-300">sessionid</span> cookie zaroori hai, lekin poori JSON paste karna behtar hai (msToken, tt-target-idc bhi chahiye).
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* ---------- profile chip ---------- */}
                <Card className="bg-zinc-900 border-zinc-800">
                  <CardContent className="p-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar className="w-11 h-11 border border-zinc-700">
                        {session.avatarUrl ? (
                          <AvatarImage src={session.avatarUrl} alt={session.nickname} />
                        ) : null}
                        <AvatarFallback className="bg-rose-600 text-white">
                          {(session.nickname || "T").slice(0, 1).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="font-semibold text-white truncate">{session.nickname}</p>
                        <p className="text-sm text-zinc-400 truncate">
                          {session.username ? `@${session.username}` : session.userId || "TikTok account"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {session.proxy && (
                        <Badge variant="secondary" className="bg-amber-950 text-amber-400 border border-amber-800 hidden sm:inline-flex">
                          {session.proxyAuto ? "Free proxy (auto)" : `Proxy: ${session.proxy}`}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="bg-emerald-950 text-emerald-400 border border-emerald-800">
                        <CircleCheck className="w-3 h-3 mr-1" aria-hidden="true" />
                        Logged in
                      </Badge>
                    </div>
                  </CardContent>
                </Card>

                {/* ---------- STEP 2: VIDEO ---------- */}
                <Card className="bg-zinc-900 border-zinc-800">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-white">
                      <span className="w-7 h-7 rounded-full bg-rose-600 text-white text-sm font-bold flex items-center justify-center">2</span>
                      Video Upload Karo
                    </CardTitle>
                    <CardDescription className="text-zinc-400">
                      Gallery se video choose karein (mp4 / mov / webm).
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*"
                      className="sr-only"
                      onChange={(e) => pickVideo(e.target.files?.[0] ?? null)}
                      aria-label="Video file choose karein"
                    />
                    {videoFile ? (
                      <div className="flex gap-3 items-start border border-zinc-800 rounded-lg p-3 bg-zinc-950">
                        {videoPreviewUrl && (
                          <video
                            src={videoPreviewUrl}
                            controls
                            className="w-32 h-44 rounded-md object-cover bg-black shrink-0"
                            aria-label="Video preview"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white truncate">{videoFile.name}</p>
                          <p className="text-xs text-zinc-400 mt-1">{formatBytes(videoFile.size)}</p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3 border-zinc-700 hover:bg-zinc-800"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            <RefreshCw className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
                            Change karo
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full border-2 border-dashed border-zinc-700 hover:border-rose-500 rounded-xl p-8 flex flex-col items-center justify-center gap-3 transition-colors bg-zinc-950/60 hover:bg-zinc-900"
                        aria-label="Video choose karne ke liye tap karein"
                      >
                        <div className="w-14 h-14 rounded-full bg-rose-600/10 border border-rose-600/30 flex items-center justify-center">
                          <CloudUpload className="w-7 h-7 text-rose-500" aria-hidden="true" />
                        </div>
                        <div className="text-center">
                          <p className="font-medium text-white">Video choose karo</p>
                          <p className="text-sm text-zinc-400 mt-1">Tap karein &mdash; gallery se video select ho jayegi</p>
                        </div>
                      </button>
                    )}
                  </CardContent>
                </Card>

                {/* ---------- STEP 3: TITLE ---------- */}
                <Card className="bg-zinc-900 border-zinc-800">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-white">
                      <span className="w-7 h-7 rounded-full bg-rose-600 text-white text-sm font-bold flex items-center justify-center">3</span>
                      Video Title
                    </CardTitle>
                    <CardDescription className="text-zinc-400">
                      Video ka caption likhein (TikTok par isi title ke sath post hoga).
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="relative">
                      <Type className="w-4 h-4 absolute left-3 top-3 text-zinc-500" aria-hidden="true" />
                      <Textarea
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Mera aaj ka video... #fyp"
                        maxLength={2200}
                        className="min-h-24 pl-9 bg-zinc-950 border-zinc-800 text-zinc-200 placeholder:text-zinc-600"
                        aria-label="Video title"
                      />
                    </div>
                    <p className="text-xs text-zinc-500 mt-1.5 text-right">{title.length}/2200</p>
                  </CardContent>
                </Card>

                {/* ---------- STEP 4: HASHTAGS ---------- */}
                <Card className="bg-zinc-900 border-zinc-800">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-white">
                      <span className="w-7 h-7 rounded-full bg-rose-600 text-white text-sm font-bold flex items-center justify-center">4</span>
                      Viral Hashtags
                    </CardTitle>
                    <CardDescription className="text-zinc-400">
                      Hashtags likhein (space ya comma se alag) &mdash; # laga kar apne aap add ho jayenge.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="relative">
                      <Tag className="w-4 h-4 absolute left-3 top-3 text-zinc-500" aria-hidden="true" />
                      <Input
                        value={hashtags}
                        onChange={(e) => setHashtags(e.target.value)}
                        placeholder="#fyp #viral #foryou"
                        className="pl-9 bg-zinc-950 border-zinc-800 text-zinc-200 placeholder:text-zinc-600 h-10"
                        aria-label="Hashtags"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {QUICK_TAGS.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => addQuickTag(tag)}
                          className="text-xs px-2.5 py-1.5 rounded-full border border-zinc-700 text-zinc-300 hover:border-rose-500 hover:text-rose-400 transition-colors bg-zinc-950"
                        >
                          #{tag}
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* ---------- visibility + POST ---------- */}
                <Card className="bg-zinc-900 border-zinc-800">
                  <CardContent className="p-4 space-y-4">
                    <RadioGroup
                      value={visibility}
                      onValueChange={setVisibility}
                      className="flex gap-4"
                      aria-label="Video visibility"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="0" id="vis-public" className="border-zinc-600 text-rose-600" />
                        <Label htmlFor="vis-public" className="text-zinc-300 font-normal cursor-pointer">
                          Public (sab ko dikhega)
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="1" id="vis-private" className="border-zinc-600 text-rose-600" />
                        <Label htmlFor="vis-private" className="text-zinc-300 font-normal cursor-pointer">
                          Private (sirf aap ko)
                        </Label>
                      </div>
                    </RadioGroup>

                    <Separator className="bg-zinc-800" />

                    <Button
                      onClick={handlePost}
                      disabled={!canPost}
                      className="w-full h-12 bg-rose-600 hover:bg-rose-700 text-white font-bold text-base shadow-lg shadow-rose-600/25"
                    >
                      {postLoading ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" aria-hidden="true" />
                          Post ho raha hai...
                        </>
                      ) : (
                        <>
                          <Send className="w-5 h-5 mr-2" aria-hidden="true" />
                          TikTok Par Post Karo
                        </>
                      )}
                    </Button>

                    {!videoFile && !postLoading && (
                      <p className="text-xs text-center text-zinc-500">Pehle video choose karein aur title likhein.</p>
                    )}
                  </CardContent>
                </Card>

                {/* ---------- sending progress (browser -> server chunks) ---------- */}
                {postLoading && uploadPhase && !job && (
                  <Card className="bg-zinc-900 border-zinc-800">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-white">
                          {uploadPhase === "sending" ? "Aapka video server par ja raha hai..." : "TikTok flow shuru ho raha hai..."}
                        </span>
                        {uploadPhase === "sending" && <span className="text-rose-400 font-mono">{uploadPct}%</span>}
                      </div>
                      {uploadPhase === "sending" && <Progress value={uploadPct} className="h-2.5 bg-zinc-800 [&>div]:bg-rose-500" />}
                      <p className="text-sm text-zinc-400 flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500 shrink-0" aria-hidden="true" />
                        {uploadPhase === "sending"
                          ? "Video tukron (chunks) me bheja ja raha hai - is tarah har size ki video safe upload hoti hai."
                          : "Server par video check ho rahi hai, TikTok par post hona shuru..."}
                      </p>
                      <p className="text-xs text-amber-500/90">Page band na karein jab tak post complete na ho jaye.</p>
                    </CardContent>
                  </Card>
                )}

                {/* ---------- progress ---------- */}
                {postLoading && job && (
                  <Card className="bg-zinc-900 border-zinc-800">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-white">TikTok par post ho raha hai...</span>
                        <span className="text-rose-400 font-mono">{job.progress}%</span>
                      </div>
                      <Progress value={job.progress} className="h-2.5 bg-zinc-800 [&>div]:bg-rose-500" />
                      <p className="text-sm text-zinc-400 flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500 shrink-0" aria-hidden="true" />
                        {job.message || "Processing..."}
                      </p>
                      <p className="text-xs text-amber-500/90">Page band na karein jab tak post complete na ho jaye.</p>
                    </CardContent>
                  </Card>
                )}

                {/* ---------- success ---------- */}
                {doneInfo && (
                  <Alert className="border-emerald-800 bg-emerald-950/40 text-emerald-200">
                    <CircleCheck className="w-4 h-4" aria-hidden="true" />
                    <AlertTitle>Video post ho gaya!</AlertTitle>
                    <AlertDescription>
                      <p className="mt-1 break-words">{doneInfo.caption}</p>
                      {doneInfo.videoId && (
                        <p className="text-xs mt-2 text-emerald-400/80">Video ID: {doneInfo.videoId} &mdash; TikTok app me apne profile par check karein.</p>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {/* ---------- error ---------- */}
                {postError && (
                  <Alert variant="destructive" className="border-rose-800 bg-rose-950/50 text-rose-200">
                    <CircleAlert className="w-4 h-4" aria-hidden="true" />
                    <AlertTitle>Post fail ho gaya</AlertTitle>
                    <AlertDescription>
                      <p className="mt-1 break-words">{postError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={retryPoll}
                        className="mt-3 border-rose-800 text-rose-300 hover:bg-rose-900/50"
                      >
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
                        Dobara try karein
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}

            {/* ---------- security note ---------- */}
            <Card className="bg-zinc-900/60 border-zinc-800">
              <CardContent className="p-4 flex gap-3 items-start">
                <Trash2 className="w-4 h-4 text-zinc-500 mt-0.5 shrink-0" aria-hidden="true" />
                <p className="text-xs text-zinc-500 leading-relaxed">
                  <span className="text-zinc-400 font-medium">Security note:</span> TikTok cookies aapke account ka poora access deti hain. Ye link sirf apne paas rakhein aur shared screen par cookies paste na karein. Logout button dabate hi cookies server se permanently delete ho jati hain.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </main>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-900/60">
        <div className="max-w-2xl mx-auto px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-2 text-xs text-zinc-600">
          <Film className="w-3.5 h-3.5" aria-hidden="true" />
          <span>TikTok Auto Post Bot &mdash; aap ke apne account par, aap ke apne videos</span>
        </div>
      </footer>
    </div>
  );
}
