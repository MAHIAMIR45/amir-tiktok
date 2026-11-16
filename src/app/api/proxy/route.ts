import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { refreshPool } from "@/lib/tiktok/proxy-pool";
import { proxyMode } from "@/lib/tiktok/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET /api/proxy -> pool status */
export async function GET() {
  try {
    const nodes = await db.proxyNode.findMany({
      orderBy: [{ lastOkAt: "desc" }, { latencyMs: "asc" }],
      take: 10,
    });
    return NextResponse.json({
      ok: true,
      mode: proxyMode(),
      healthy: await db.proxyNode.count(),
      nodes: nodes.map((n) => ({
        host: n.host,
        port: n.port,
        country: n.country,
        latencyMs: n.latencyMs,
        okCount: n.okCount,
        lastOkAt: n.lastOkAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Pool status load fail." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/proxy -> refresh the free proxy pool (fetch public lists, test against
 * TikTok, keep the healthy ones). Takes ~30-90s.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(body.max ?? 220), 40), 400);
    const result = await refreshPool(max, 24);
    return NextResponse.json({
      ok: result.healthy > 0,
      scanned: result.scanned,
      okCount: result.okCount,
      healthy: result.healthy,
      error:
        result.healthy > 0
          ? undefined
          : "Is round me koi free proxy TikTok tak nahi pahunch saka. Dobara try karein (public proxies waqt ke sath marte rehte hain).",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Pool refresh fail." },
      { status: 500 },
    );
  }
}
