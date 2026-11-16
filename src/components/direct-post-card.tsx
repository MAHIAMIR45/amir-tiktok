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
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Smartphone,
  Zap,
} from "lucide-react";

/**
 * "Pakka Hal" — Direct Post (userscript) mode.
 *
 * Ye mode bilkul alag hai cookie-wale server flow se: video aap ke phone se SEEDHA
 * TikTok ke apne upload page (TikTok Studio) par jati hai. Koi cookie copy nahi,
 * koi proxy nahi, koi server hop nahi — is liye TikTok ka session kabhi reject nahi
 * hota aur video upload bhi fast hoti hai.
 */
export function DirectPostCard() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  const SCRIPT_URL = "/tiktok-auto-post.user.js";

  const handleCopy = async () => {
    setCopyError("");
    try {
      const res = await fetch(SCRIPT_URL, { cache: "no-store" });
      const text = await res.text();
      if (!res.ok || text.length < 1000) throw new Error("script load fail");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      setCopyError(
        "Copy nahi ho saka — 'Raw Script Kholo' dabayein, poori script ek naye tab me khul jayegi. Wahan sab select kar ke copy karein aur Violentmonkey me paste karein."
      );
      window.open(SCRIPT_URL, "_blank");
    }
  };

  return (
    <Card className="bg-emerald-950/40 border-emerald-800">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-white">
          <span className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center shrink-0">
            <Smartphone className="w-4.5 h-4.5 text-white" aria-hidden="true" />
          </span>
          Pakka Hal: Direct Post (Userscript)
          <Badge className="bg-emerald-800 text-emerald-200 border border-emerald-600">
            <Zap className="w-3 h-3 mr-1" aria-hidden="true" />
            Bina cookies &middot; bina proxy
          </Badge>
        </CardTitle>
        <CardDescription className="text-emerald-200/80">
          <span className="font-medium text-emerald-200">Recommended:</span> Is mode me video aap ke phone se{" "}
          <span className="text-white font-medium">seedha TikTok par jati hai</span> &mdash; server se nahi guzarti, cookies ki zaroorat
          nahi, proxy ki zaroorat nahi. TikTok ka apna login aur apna uploader use hota hai, is liye &ldquo;session invalid&rdquo; ka
          masla hi khatam ho jata hai. Ye <span className="text-white">100% free</span> aur permanent tareeqa hai.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Collapsible className="border border-emerald-900 rounded-lg">
          <CollapsibleTrigger className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium hover:bg-emerald-900/30 rounded-lg text-emerald-100">
            <span className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-500" aria-hidden="true" />
              3 Steps Setup (ek dafa karein, hamesha chalega)
            </span>
            <ChevronDown className="w-4 h-4 text-emerald-600" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="px-4 pb-4 pt-1 text-sm text-emerald-100/90 space-y-2.5 list-decimal list-inside leading-relaxed">
              <li>
                <span className="text-white font-medium">Kiwi Browser</span> me Chrome Web Store kholo aur{" "}
                <span className="text-emerald-400 font-medium">Violentmonkey</span> extension install karo (Kiwi me Chrome extensions
                chalte hain).
              </li>
              <li>
                Neeche <span className="text-emerald-400 font-medium">Script Copy Karo</span> dabao. Phir Kiwi me Violentmonkey ka
                dashboard kholo &rarr; <span className="text-white">+</span> (naya script) &rarr; sab kuch delete kar ke jo copy kiya
                wo paste karo &rarr; <span className="text-white">Save</span>.
              </li>
              <li>
                Kiwi me <span className="text-white">tiktok.com</span> kholo (apni ID se login ho) &rarr; menu se{" "}
                <span className="text-white">Desktop site</span> ON karo &rarr;{" "}
                <span className="text-emerald-400 font-medium">tiktok.com/tiktokstudio/upload</span> kholo. Neeche{" "}
                <span className="text-white">&ldquo;&#9889; Direct Post&rdquo;</span> panel nazar aayega &mdash; video choose karo,
                caption likho (save ho jata hai), <span className="text-white">FULL AUTO POST</span> dabao. Bas!
              </li>
            </ol>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={handleCopy}
            className="flex-1 h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
          >
            {copied ? (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" aria-hidden="true" />
                Copy ho gaya!
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" aria-hidden="true" />
                Script Copy Karo
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => window.open(SCRIPT_URL, "_blank")}
            className="flex-1 h-11 border-emerald-700 text-emerald-300 hover:bg-emerald-900/40"
          >
            <ExternalLink className="w-4 h-4 mr-2" aria-hidden="true" />
            Raw Script Kholo
          </Button>
        </div>

        {copyError && (
          <Alert className="border-amber-800 bg-amber-950/40 text-amber-200">
            <AlertDescription className="text-xs">{copyError}</AlertDescription>
          </Alert>
        )}

        <p className="text-[11px] text-emerald-300/70 leading-relaxed">
          Panel ke andar &ldquo;FULL AUTO POST&rdquo; video ko TikTok ke uploader me daal kar process ka intezar karta hai, caption bhar
          deta hai aur Post button daba deta hai. Har step ka alag button bhi hai (1/2/3) agar auto kisi step par ruk jaye. Caption
          template save ho jata hai &mdash; agli video ke liye dobara likhna nahi parega.
        </p>
      </CardContent>
    </Card>
  );
}
