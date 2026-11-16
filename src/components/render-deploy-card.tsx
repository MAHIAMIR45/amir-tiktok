"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CloudUpload,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Info,
} from "lucide-react";

/**
 * Render deployment card: free cloud hosting (render.com) par deploy karne ka tareeqa.
 * Direct mode (TT_PROXY_MODE=direct) ke sath server ka apna stable IP use hota hai —
 * free rotating proxies se bohat behtar, lekin datacenter IP hone ki wajah se 100%
 * guarantee nahi. Wahi case Direct Post (userscript) backup card handle karta hai.
 */
export function RenderDeployCard() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyGuide = async () => {
    const text = [
      "RENDER DEPLOYMENT - STEP BY STEP",
      "",
      "1) GitHub par free account banao (github.com) aur ek PRIVATE repo banao (jaise tiktok-bot).",
      "2) Ye project ka code us repo me push karo (git init / add / commit / push) - ya kisi tarah repo me upload karo.",
      "3) render.com kholo -> free account banao (Google/GitHub se sign up).",
      "4) Dashboard par New + -> Web Service -> 'Build and deploy from a Git repository' -> apna GitHub repo connect karo.",
      "5) Render khud repo ki render.yaml padh lega: Docker runtime, free plan, direct mode (TT_PROXY_MODE=direct). Bas 'Create Web Service' dabao.",
      "6) Build 5-10 minute lega (Docker + chromium install). Log dekhte rahein.",
      "7) Deploy complete hone par Render aap ko URL dega (jaise tiktok-bot-xxxx.onrender.com).",
      "8) Us URL par Kiwi/browser me kholo -> cookies paste kar ke Login karo -> video + caption + hashtags -> Post!",
      "",
      "IMPORTANT NOTES (free plan):",
      "- Server 15 min idle ke baad so jata hai; pehli request ~1 minute leti hai (cold start).",
      "- Server restart/deploy par database reset hoti hai (cookies dobara paste karni par sakti hain).",
      "- Render ka IP bhi datacenter hai: TikTok supported region (US) + stable IP hai, is liye free proxies se bohat behtar - lekin agar TikTok phir bhi session reject kare to 'Pakka Hal: Direct Post (Userscript)' card use karein (wo phone ka apna IP use karta hai, 100% chalta hai).",
      "- Pehli post PRIVATE kar ke test karein (safety best practice), phir public posts karein.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Card className="bg-sky-950/40 border-sky-800">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-white">
          <span className="w-8 h-8 rounded-lg bg-sky-600 flex items-center justify-center shrink-0">
            <CloudUpload className="w-5 h-5 text-white" aria-hidden="true" />
          </span>
          Render Par Deploy Karo (Free Cloud Server)
          <Badge className="bg-sky-800 text-sky-200 border border-sky-600">
            Direct mode: stable IP
          </Badge>
        </CardTitle>
        <CardDescription className="text-sky-200/80">
          Is bot ko <span className="text-white font-medium">render.com</span> ke free plan par deploy karein. Server US region ka{" "}
          <span className="text-white font-medium">stable IP</span> use hoga (free rotating proxies se{" "}
          <span className="text-white font-medium">bohat behtar</span>) aur login/post direct chalega — koi proxy dhoondne ki zaroorat
          nahi. Code bilkul wahi chalega jo is page par hai.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Collapsible open={open} onOpenChange={setOpen} className="border border-sky-900 rounded-lg">
          <CollapsibleTrigger className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium hover:bg-sky-900/30 rounded-lg text-sky-100">
            <span className="flex items-center gap-2">
              <CircleCheck className="w-4 h-4 text-sky-500" aria-hidden="true" />
              Deployment Steps (8 steps - 15/20 minute ka kaam)
            </span>
            <ChevronDown className="w-4 h-4 text-sky-600" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="px-4 pb-4 pt-1 text-sm text-sky-100/90 space-y-2.5 list-decimal list-inside leading-relaxed">
              <li>
                <span className="text-white font-medium">github.com</span> par free account banao aur ek{" "}
                <span className="text-white">private repo</span> banao (jaise <span className="text-sky-400">tiktok-bot</span>).
              </li>
              <li>Ye project ka code us repo me push/upload karo.</li>
              <li>
                <span className="text-white font-medium">render.com</span> kholo &rarr; free account (Google/GitHub sign up) &rarr;{" "}
                Dashboard par <span className="text-white">New + &rarr; Web Service</span>.
              </li>
              <li>
                <span className="text-white">Build and deploy from a Git repository</span> chuno &rarr; apna repo connect karo.
              </li>
              <li>
                Render khud repo ki <span className="text-sky-400">render.yaml</span> padh lega (Docker, free plan, direct mode) &rarr;{" "}
                <span className="text-white">Create Web Service</span> dabao.
              </li>
              <li>Build 5-10 minute lega (chromium install hota hai) &mdash; logs dekhte rahein.</li>
              <li>
                Ready hone par URL milega (<span className="text-sky-400">aapka-app.onrender.com</span>) &mdash; usay Kiwi me kholo.
              </li>
              <li>
                Cookies paste kar ke <span className="text-white">Login</span> &rarr; video + caption + hashtags &rarr;{" "}
                <span className="text-white">Post</span>. Pehli post <span className="text-white">Private</span> rakh kar test karna
                behtar hai.
              </li>
            </ol>
            <div className="px-4 pb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={copyGuide}
                className="border-sky-700 text-sky-300 hover:bg-sky-900/40"
              >
                {copied ? (
                  <>
                    <CircleCheck className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
                    Guide copy ho gayi
                  </>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" aria-hidden="true" />
                    Poori guide copy karein (text)
                  </span>
                )}
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <Alert className="border-amber-800/60 bg-amber-950/30 text-amber-200">
          <CircleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
          <AlertDescription className="text-xs leading-relaxed">
            <span className="font-medium">Imandari se bata dun:</span> Render ka IP bhi datacenter ka hai &mdash; region TikTok-supported
            (US) aur IP stable hai, is liye free proxies se kafi behtar chances hain, lekin TikTok agar datacenter IP par bhi session
            reject kare to wo 100% pakka hal sirf neeche wala{" "}
            <span className="text-white">Pakka Hal: Direct Post (Userscript)</span> card hai (wo aap ke phone ka apna IP use karta hai).
            Dono try karna behtar hai &mdash; Render wala zyada aaram deh hai, userscript wala guaranteed hai.
          </AlertDescription>
        </Alert>

        <p className="text-[11px] text-sky-300/70 leading-relaxed">
          Free plan notes: server 15 min idle ke baad so jata hai (pehli request ~1 min leti hai, cold start); deploy/restart par
          database reset hoti hai (cookies dobara paste karni par sakti hain); bun ki jagah server Node par chalta hai (undici
          compatibility ke liye) aur publish signing ke liye chromium Docker me installed hota hai.
        </p>
      </CardContent>
    </Card>
  );
}
