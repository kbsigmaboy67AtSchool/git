/**
 * n3xn Cloudflare Pages middleware
 *
 * CRITICAL: /devtools.js must be handled HERE before auth + before [[path]].js
 * or the proxy will 404 it against the upstream site.
 */

const SESSION_COOKIE = "n3xn_session";
const SESSION_TTL = 60 * 60 * 24 * 30;

const UPSTREAM_JS =
  "https://raw.githubusercontent.com/kbsigmaboy67AtSchool/git/main/public/devtools.js";
const UPSTREAM_CSS =
  "https://raw.githubusercontent.com/kbsigmaboy67AtSchool/git/main/public/devtools.css";
const CDN_JS =
  "https://cdn.jsdelivr.net/gh/kbsigmaboy67AtSchool/git@main/public/devtools.js";
const CDN_CSS =
  "https://cdn.jsdelivr.net/gh/kbsigmaboy67AtSchool/git@main/public/devtools.css";

function loginPage(error = "") {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>n3xn — Private</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%}
body{display:grid;place-items:center;background:#080a0f;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif}
.box{width:min(390px,calc(100vw - 32px));padding:30px;border:1px solid #30363d;border-radius:14px;background:#0d1117;box-shadow:0 20px 60px #0008}
h1{margin:0 0 6px;font-size:24px}
p{margin:0 0 22px;color:#8b949e}
input{width:100%;padding:12px;margin-bottom:10px;border:1px solid #30363d;border-radius:7px;outline:none;background:#010409;color:#fff;font:inherit}
input:focus{border-color:#58a6ff}
button{width:100%;padding:12px;border:0;border-radius:7px;background:#238636;color:#fff;font-weight:600;cursor:pointer}
.err{margin-bottom:12px;color:#ff7b72}
</style>
</head>
<body>
<form class="box" method="POST" action="/login">
<h1>n3xn</h1>
<p>Private access</p>
${error ? `<div class="err">${error}</div>` : ""}
<input name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus required>
<button type="submit">Continue</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function makeSignature(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function checkSession(request, secret) {
  if (!secret) return false;
  const cookies = request.headers.get("Cookie") || "";
  const token = cookies.match(/(?:^|;\s*)n3xn_session=([^;]+)/)?.[1];
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expires, signature] = parts;
  if (!/^\d+$/.test(expires)) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = await makeSignature(expires, secret);
  return signature === expected;
}

function sessionCookie(expires, signature) {
  return [
    `${SESSION_COOKIE}=${expires}.${signature}`,
    "Path=/",
    `Max-Age=${SESSION_TTL}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function isDevtoolsAssetPath(pathname) {
  const p = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return (
    p === "/devtools.js" ||
    p === "/n3xn-dt.js" ||
    p === "/n3xn-devtools.js" ||
    p === "/devtools.css" ||
    p === "/n3xn-dt.css"
  );
}

function isCssPath(pathname) {
  const p = pathname.toLowerCase();
  return p.endsWith(".css") && isDevtoolsAssetPath(pathname);
}

async function fetchText(urls) {
  for (const src of urls) {
    try {
      const res = await fetch(src, {
        cf: { cacheTtl: 30, cacheEverything: true },
        headers: { "User-Agent": "n3xn-devtools-proxy" },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length > 100) return text;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function serveDevtoolsJs() {
  const body = await fetchText([UPSTREAM_JS, CDN_JS]);
  if (!body) {
    return new Response(
      "console.error('n3xn: failed to load devtools.js from upstream');",
      {
        status: 502,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=30, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function serveDevtoolsCss() {
  const body = await fetchText([UPSTREAM_CSS, CDN_CSS]);
  if (!body) {
    return new Response("/* n3xn css upstream failed */", {
      status: 502,
      headers: { "Content-Type": "text/css; charset=utf-8" },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=30, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Inline loader: tries same-origin first, then CDN (cache-busted).
 * Avoids total failure when /devtools.js 404s on an old deploy.
 */
function injectDevTools(html) {
  const boot = `
<style id="n3xn-dt-early">
html.n3xn-dt-open{margin-bottom:var(--n3xn-dt-height,40vh)!important}
</style>
<script id="n3xn-dt-boot">
(function(){
  if (window.__n3xnDtBoot) return;
  window.__n3xnDtBoot = 1;
  function load(src, next) {
    var s = document.createElement("script");
    s.src = src;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = function () { if (next) next(); };
    document.documentElement.appendChild(s);
  }
  // 1) same-origin (middleware / function)
  // 2) jsDelivr with cache-bust so pushes show up
  load("/devtools.js", function () {
    load("/n3xn-dt.js", function () {
      load(${JSON.stringify(CDN_JS + "?t=")} + Date.now(), null);
    });
  });
})();
</script>`.trim();

  let out = html;
  if (/<\/head\s*>/i.test(out)) {
    out = out.replace(/<\/head\s*>/i, `${boot}</head>`);
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${boot}`);
  } else if (/<\/body\s*>/i.test(out)) {
    out = out.replace(/<\/body\s*>/i, `${boot}</body>`);
  } else if (/<\/html\s*>/i.test(out)) {
    out = out.replace(/<\/html\s*>/i, `${boot}</html>`);
  } else {
    out += boot;
  }
  return out;
}

function isHtmlResponse(response, url) {
  const ct = (response.headers.get("Content-Type") || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  if (ct.includes("application/xhtml")) return true;
  if (!ct || ct === "text/plain") {
    const path = url.pathname.toLowerCase();
    if (
      path === "/" ||
      path.endsWith(".html") ||
      path.endsWith(".htm") ||
      path.endsWith("/") ||
      !path.includes(".")
    ) {
      return true;
    }
  }
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  /* ── DevTools assets FIRST (no auth) — prevents [[path]] proxy 404 ── */
  if (isDevtoolsAssetPath(path)) {
    if (isCssPath(path)) return serveDevtoolsCss();
    return serveDevtoolsJs();
  }

  /* ── Login ── */
  if (path === "/login") {
    if (request.method === "GET") return loginPage();
    if (request.method === "POST") {
      const form = await request.formData();
      const supplied = String(form.get("password") || "");
      if (!env.N3XN_PASSWORD || supplied !== env.N3XN_PASSWORD) {
        return loginPage("Incorrect password.");
      }
      if (!env.N3XN_SESSION_SECRET) {
        return new Response("N3XN_SESSION_SECRET is missing.", { status: 500 });
      }
      const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
      const signature = await makeSignature(
        String(expires),
        env.N3XN_SESSION_SECRET,
      );
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": sessionCookie(expires, signature),
        },
      });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (path === "/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login",
        "Set-Cookie":
          `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  }

  if (path === "/devtools-auth") {
    return context.next();
  }

  const authenticated = await checkSession(request, env.N3XN_SESSION_SECRET);
  if (!authenticated) return loginPage();

  const response = await context.next();

  // If something else 404'd a devtools path, still try to serve it
  if (response.status === 404 && isDevtoolsAssetPath(path)) {
    if (isCssPath(path)) return serveDevtoolsCss();
    return serveDevtoolsJs();
  }

  if (!isHtmlResponse(response, url)) {
    return response;
  }

  let body;
  try {
    body = await response.text();
  } catch {
    return response;
  }

  if (body.includes("n3xn-dt-boot") || body.includes("n3xn-dt-early")) {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const injected = injectDevTools(body);
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Content-Security-Policy");
  headers.delete("Content-Security-Policy-Report-Only");
  if (!headers.get("Content-Type")?.toLowerCase().includes("html")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
  }

  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
