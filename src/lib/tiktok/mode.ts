/**
 * Proxy mode control via env var TT_PROXY_MODE:
 *  - "pool"   (default): TikTok requests go through free public proxies (sandbox/HK jaisi
 *             regions ke liye zaroori, kyunke wahan direct request region-block hoti hai).
 *  - "direct": server ka APNA stable IP use hota hai (Render/VPS jaisi TikTok-supported
 *              regions ke liye) - koi free proxy nahi, stable datacenter IP.
 *
 * render.yaml is mode ko "direct" set karti hai.
 */
export type ProxyMode = "direct" | "pool";

export function proxyMode(): ProxyMode {
  const v = (process.env.TT_PROXY_MODE ?? "pool").trim().toLowerCase();
  return v === "direct" ? "direct" : "pool";
}

/** Roman-Urdu label for the UI/status messages. */
export function proxyModeLabel(): string {
  return proxyMode() === "direct" ? "Direct (server ka apna IP)" : "Free proxy pool";
}
