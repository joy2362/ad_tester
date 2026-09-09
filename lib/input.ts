import type { InputMode, ResolvedInputType } from "./types";

export const SANDBOX_ORIGIN = "https://sandbox.ad-tester.local";
export const SANDBOX_URL = `${SANDBOX_ORIGIN}/`;

const HTML_TAG_RE = /<\s*(script|iframe|ins|div|a|img|amp-ad|video|object|embed|template)[\s>]/i;
const URL_RE = /^https?:\/\/\S+$/i;

export function resolveInputType(raw: string, mode: InputMode): ResolvedInputType {
  const value = raw.trim();
  if (mode !== "auto") return mode;

  if (HTML_TAG_RE.test(value)) {
    return /<\s*script[\s>]/i.test(value) || /<\s*ins[\s>]/i.test(value) || /<\s*iframe[\s>]/i.test(value)
      ? "script-tag"
      : "raw-html";
  }
  if (URL_RE.test(value) && !value.includes(" ")) {
    const noQuery = value.split("?")[0].toLowerCase();
    if (noQuery.endsWith(".js") || noQuery.endsWith(".mjs")) return "script-url";
    return "script-url";
  }
  // Fallback: assume it's a JS body / snippet.
  return "raw-html";
}

function escapeForHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Builds the full sandbox document that will be served for the first navigation. */
export function buildSandboxDocument(raw: string, resolvedType: ResolvedInputType): string {
  const value = raw.trim();
  let adMarkup: string;

  switch (resolvedType) {
    case "script-url":
      adMarkup = `<script src="${escapeForHtml(value)}"></script>`;
      break;
    case "iframe-url":
      adMarkup = `<iframe src="${escapeForHtml(value)}" width="100%" height="100%" style="border:0" allow="autoplay; fullscreen"></iframe>`;
      break;
    case "script-tag":
    case "raw-html":
    default:
      adMarkup = value;
      break;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ad Tester Sandbox</title>
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  #ad-tester-container { min-height: 100%; }
  #ad-tester-container iframe { border: 0; }
</style>
</head>
<body>
<div id="ad-tester-container">
${adMarkup}
</div>
<script>
(function () {
  // Auto-play any video creatives muted so screenshots capture a frame.
  function primeVideos(root) {
    (root.querySelectorAll ? root.querySelectorAll('video') : []).forEach(function (v) {
      try { v.muted = true; v.autoplay = true; v.playsInline = true; var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    });
  }
  primeVideos(document);
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType === 1) primeVideos(n);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>
</body>
</html>`;
}
