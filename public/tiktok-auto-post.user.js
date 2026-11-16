// ==UserScript==
// @name         TikTok Direct Post Helper
// @namespace    ttkbot-direct-post
// @version      1.0.0
// @description  Video + caption seedha apne phone se TikTok par post karo — cookies ki zaroorat nahi, proxy ki zaroorat nahi. TikTok ka apna uploader use hota hai.
// @match        https://www.tiktok.com/tiktokstudio/*
// @match        https://www.tiktok.com/upload*
// @match        https://www.tiktok.com/*/upload*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * YE KAISE KAAM KARTA HAI?
 * Ye script TikTok ke APNE upload page (TikTok Studio) ke andar chalti hai:
 *  - Aap ki asli logged-in session use hoti hai (koi cookie copy nahi)
 *  - Video aap ke phone se seedha TikTok ke server par jati hai (koi proxy nahi)
 *  - TikTok ka apna uploader signatures/tokens khud banata hai (koi block nahi)
 * Script sirf madad karta hai: file inject, caption bharwana aur Post button dabwana.
 */
(function () {
  "use strict";

  // --------------------------------------------------------------- state
  var pickedFile = null;
  var captionTemplate = "";
  var busy = false;

  try {
    captionTemplate = window.localStorage.getItem("ttap_caption") || "";
  } catch (e) { /* ignore */ }

  function saveCaption(v) {
    captionTemplate = v;
    try { window.localStorage.setItem("ttap_caption", v); } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    var el = $("ttap-status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = kind === "err" ? "#fb7185" : kind === "ok" ? "#34d399" : "#d4d4d8";
  }

  var QUICK_TAGS = ["fyp", "foryou", "viral", "trending", "pakistan", "funny", "islamic", "dailyvlog"];

  // --------------------------------------------------------------- TikTok page finders
  function findFileInput() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'));
    var video = inputs.filter(function (i) { return (i.accept || "").toLowerCase().indexOf("video") !== -1; });
    if (video.length) return video[0];
    return inputs.length ? inputs[0] : null;
  }

  function findCaptionEditor() {
    // TikTok Studio: contenteditable div (sab se bara = caption editor)
    var divs = Array.prototype.slice.call(document.querySelectorAll('div[contenteditable="true"]'));
    var best = null, bestArea = 0;
    for (var i = 0; i < divs.length; i++) {
      var r = divs[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea && area > 1000) { bestArea = area; best = divs[i]; }
    }
    if (best) return best;
    // Legacy uploader: textarea
    var tas = Array.prototype.slice.call(document.querySelectorAll("textarea"));
    for (var j = 0; j < tas.length; j++) {
      var ph = tas[j].placeholder || "";
      if (/caption|describe|video/i.test(ph)) return tas[j];
    }
    return tas.length ? tas[0] : null;
  }

  function findPostButton() {
    var b = document.querySelector('button[data-e2e="post_video_button"]');
    if (b) return b;
    var btns = Array.prototype.slice.call(document.querySelectorAll("button"));
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim().toLowerCase();
      if (t === "post" || t === "publish") return btns[i];
    }
    return null;
  }

  function postReady(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute("aria-disabled") === "true") return false;
    var cls = btn.className || "";
    return cls.indexOf("disabled") === -1;
  }

  // --------------------------------------------------------------- automation steps
  function stepInjectFile() {
    if (!pickedFile) throw new Error("Pehle video choose karein (Video Choose Karo button).");
    var input = findFileInput();
    if (!input) throw new Error("TikTok ka file input nahi mila. TikTok Studio upload page kholo: tiktok.com/tiktokstudio/upload");
    var dt = new window.DataTransfer();
    dt.items.add(pickedFile);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  }

  function stepFillCaption() {
    var text = ($("ttap-caption") ? $("ttap-caption").value : captionTemplate) || "";
    if (!text.trim()) throw new Error("Caption khali hai — pehle caption likhein.");
    saveCaption(text);
    var el = findCaptionEditor();
    if (!el) throw new Error("Caption box nahi mila — TikTok ne video process hone di? TikTok ka apna caption box use karein.");
    el.focus();
    if (el.tagName === "TEXTAREA") {
      var proto = window.HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      try { document.execCommand("selectAll", false, null); } catch (e) { /* ignore */ }
      var ok = document.execCommand("insertText", false, text);
      if (!ok) {
        // fallback: paste event simulation
        el.textContent = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return el;
  }

  function stepClickPost() {
    var btn = findPostButton();
    if (!btn) throw new Error("Post button nahi mila. TikTok page par 'Post' button daba dein (manually).");
    if (!postReady(btn)) throw new Error("Post button abhi disabled hai — TikTok video process kar raha hai. 1-2 minute baad '3' button dobara dabayein.");
    btn.click();
    return btn;
  }

  function waitForReady(onTick, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15 * 60 * 1000);
    return new Promise(function (resolve, reject) {
      var timer = setInterval(function () {
        var btn = findPostButton();
        var done = postReady(btn);
        onTick(Date.now(), deadline, done);
        if (done) { clearInterval(timer); resolve(btn); return; }
        if (Date.now() > deadline) { clearInterval(timer); reject(new Error("TikTok bohat der tak process nahi hua (timeout). Manual post karein.")); }
      }, 1000);
    });
  }

  // --------------------------------------------------------------- panel UI
  var css = {
    panel: "position:fixed;z-index:2147483647;bottom:12px;right:12px;width:330px;max-width:calc(100vw - 24px);" +
      "background:#111114;color:#e4e4e7;border:1px solid #3f3f46;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.55);" +
      "font:13px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif;overflow:hidden;",
    head: "display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1c1c21;cursor:pointer;",
    body: "padding:12px;display:flex;flex-direction:column;gap:10px;max-height:70vh;overflow:auto;",
    btn: "width:100%;border:none;border-radius:8px;padding:10px;font-weight:600;font-size:13px;cursor:pointer;",
    btn2: "border-radius:8px;padding:8px;font-size:12px;cursor:pointer;border:1px solid #52525b;background:#27272a;color:#e4e4e7;",
    tag: "border:1px solid #52525b;background:#18181b;color:#a1a1aa;border-radius:999px;padding:3px 9px;font-size:11px;cursor:pointer;",
    ta: "width:100%;box-sizing:border-box;min-height:74px;background:#09090b;border:1px solid #3f3f46;border-radius:8px;" +
      "color:#e4e4e7;padding:8px;font:12px/1.4 inherit;resize:vertical;",
    status: "min-height:18px;font-size:12px;color:#d4d4d8;",
    note: "font-size:11px;color:#71717a;",
    file: "font-size:12px;color:#a1a1aa;word-break:break-all;",
    input: "display:none;",
  };

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }

  function mountPanel() {
    if ($("ttap-panel")) return;

    // minimized pill
    var pill = el("div",
      "position:fixed;z-index:2147483647;bottom:12px;right:12px;background:#e11d48;color:#fff;border-radius:999px;" +
      "padding:9px 14px;font:600 13px -apple-system,'Segoe UI',Roboto,sans-serif;box-shadow:0 6px 20px rgba(225,29,72,.45);cursor:pointer;",
      "\u26A1 Direct Post");
    pill.id = "ttap-pill";
    pill.style.display = "none";
    document.body.appendChild(pill);

    var panel = el("div", css.panel);
    panel.id = "ttap-panel";

    // header
    var head = el("div", css.head);
    var title = el("div", null, "\u26A1 Direct Post Helper");
    title.style.fontWeight = "700";
    var minBtn = el("span", "color:#a1a1aa;font-size:15px;", "\u2013");
    head.appendChild(title);
    head.appendChild(minBtn);
    panel.appendChild(head);

    var body = el("div", css.body);
    body.id = "ttap-body";

    // video row
    var fileInput = el("input", css.input);
    fileInput.type = "file";
    fileInput.accept = "video/*";
    fileInput.id = "ttap-file";
    var pickBtn = el("button", css.btn + "background:#e11d48;color:#fff;", "\u{1F3AC} Video Choose Karo");
    var fileName = el("div", css.file, "Koi video nahi chuni.");
    pickBtn.onclick = function () { fileInput.click(); };
    fileInput.onchange = function () {
      pickedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      fileName.textContent = pickedFile
        ? pickedFile.name + " (" + (pickedFile.size / 1048576).toFixed(1) + " MB)"
        : "Koi video nahi chuni.";
      fileName.style.color = pickedFile ? "#34d399" : "#a1a1aa";
    };
    body.appendChild(fileInput);
    body.appendChild(pickBtn);
    body.appendChild(fileName);

    // caption
    var capLabel = el("div", css.note, "Caption + Hashtags (template save ho jata hai):");
    var ta = el("textarea", css.ta);
    ta.id = "ttap-caption";
    ta.placeholder = "Mera aaj ka video... #fyp #viral";
    ta.value = captionTemplate;
    ta.oninput = function () { saveCaption(ta.value); };
    body.appendChild(capLabel);
    body.appendChild(ta);

    // quick tags
    var tagRow = el("div", "display:flex;flex-wrap:wrap;gap:5px;");
    QUICK_TAGS.forEach(function (t) {
      var chip = el("span", css.tag, "#" + t);
      chip.onclick = function () {
        var cur = ta.value.trim();
        if (cur.toLowerCase().indexOf("#" + t.toLowerCase()) !== -1) return;
        ta.value = cur ? cur + " #" + t : "#" + t;
        saveCaption(ta.value);
      };
      tagRow.appendChild(chip);
    });
    body.appendChild(tagRow);

    // status
    var status = el("div", css.status, "Tayyar hai — video choose karein.");
    status.id = "ttap-status";
    body.appendChild(status);

    // FULL AUTO
    var autoBtn = el("button", css.btn + "background:#e11d48;color:#fff;", "\u26A1 FULL AUTO POST");
    autoBtn.onclick = function () { runFullAuto(autoBtn); };
    body.appendChild(autoBtn);

    // manual steps
    var manual = el("div", "display:flex;flex-direction:column;gap:6px;");
    var steps = [
      ["1) Video TikTok me daalo", function () { stepInjectFile(); }],
      ["2) Caption bharo", function () { stepFillCaption(); }],
      ["3) Post button dabao", function () { stepClickPost(); }],
    ];
    var stepMsgs = [
      "Video TikTok ke uploader me inject ho gayi \u2014 ab TikTok ka apna upload/progress dekhein.",
      "Caption bhar diya gaya \u2014 TikTok ke editor me check karein.",
      "Post button daba diya! Profile par video check karein.",
    ];
    steps.forEach(function (s, idx) {
      var b = el("button", css.btn2, s[0]);
      b.onclick = function () {
        if (busy) return;
        try { s[1](); setStatus(stepMsgs[idx], "ok"); }
        catch (e) { setStatus(e.message || e, "err"); }
      };
      manual.appendChild(b);
    });
    body.appendChild(manual);

    var note = el("div", css.note,
      "Visibility (Public/Private) TikTok ke apne page par set karein \u2014 default Public hota hai. " +
      "Agar file input na mile to TikTok Studio upload page kholo: tiktok.com/tiktokstudio/upload (Desktop site ON rakhein).");
    body.appendChild(note);

    panel.appendChild(body);
    document.body.appendChild(panel);

    // minimize / restore
    function minimize() {
      panel.style.display = "none";
      pill.style.display = "block";
      try { window.localStorage.setItem("ttap_min", "1"); } catch (e) { }
    }
    function restore() {
      panel.style.display = "block";
      pill.style.display = "none";
      try { window.localStorage.setItem("ttap_min", "0"); } catch (e) { }
    }
    minBtn.onclick = minimize;
    pill.onclick = restore;
    try { if (window.localStorage.getItem("ttap_min") === "1") minimize(); } catch (e) { }
  }

  // --------------------------------------------------------------- full auto
  function runFullAuto(autoBtn) {
    if (busy) return;
    busy = true;
    var old = autoBtn.textContent;
    autoBtn.textContent = "Chal raha hai...";
    var t0 = Date.now();

    setStatus("1/4: Video TikTok ke uploader me inject ho rahi hai...");
    Promise.resolve()
      .then(function () { return stepInjectFile(); })
      .then(function () {
        setStatus("2/4: TikTok video upload/process kar raha hai — TikTok ka progress bar dekhein... (auto)");
        return waitForReady(function (now, deadline, done) {
          if (!done) {
            var s = Math.round((now - t0) / 1000);
            setStatus("2/4: TikTok process kar raha hai... " + s + "s (bada file = zyada waqt)");
          }
        });
      })
      .then(function () {
        setStatus("3/4: Caption bhar raha hai...");
        return stepFillCaption();
      })
      .then(function () {
        setStatus("4/4: Post button daba raha hai...");
        return new Promise(function (r) { setTimeout(function () { r(stepClickPost()); }, 700); });
      })
      .then(function () {
        setStatus("HO GAYA! Video TikTok par post ho gayi \u2014 apne profile par check karein.", "ok");
      })
      .catch(function (e) {
        setStatus("Ruk gaya: " + (e && e.message ? e.message : e) + " \u2014 Manual steps (1/2/3) se aage barhayein.", "err");
      })
      .then(function () {
        busy = false;
        autoBtn.textContent = old;
      });
  }

  // --------------------------------------------------------------- boot + SPA watchdog
  function boot() {
    if (!document.body) { setTimeout(boot, 500); return; }
    mountPanel();
    // SPA navigation me TikTok DOM dobara bana deta hai — panel dobara mount karo agar gayab ho
    setInterval(function () { mountPanel(); }, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
