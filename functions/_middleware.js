/**
 * n3xn Cloudflare Pages middleware
 *
 * - Session login / logout
 * - Injects DevTools into every text/html response
 *   (top-level navigations and iframe HTML)
 * - Strips CSP so the injected script can run
 */

const SESSION_COOKIE = "n3xn_session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

// Prefer same-origin if you host the script; fall back to raw GitHub
const DEVTOOLS_SCRIPT =
  "https://raw.githubusercontent.com/kbsigmaboy67AtSchool/git/main/public/devtools.js";

/* ------------------------------------------------------------------ */
/* Login page                                                          */
/* ------------------------------------------------------------------ */

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
body{
  display:grid;place-items:center;
  background:#080a0f;color:#e6edf3;
  font-family:system-ui,-apple-system,sans-serif
}
.box{
  width:min(390px,calc(100vw - 32px));
  padding:30px;border:1px solid #30363d;border-radius:14px;
  background:#0d1117;box-shadow:0 20px 60px #0008
}
h1{margin:0 0 6px;font-size:24px}
p{margin:0 0 22px;color:#8b949e}
input{
  width:100%;padding:12px;margin-bottom:10px;
  border:1px solid #30363d;border-radius:7px;outline:none;
  background:#010409;color:#fff;font:inherit
}
input:focus{border-color:#58a6ff}
button{
  width:100%;padding:12px;border:0;border-radius:7px;
  background:#238636;color:#fff;font-weight:600;cursor:pointer
}
.err{margin-bottom:12px;color:#ff7b72}
</style>
</head>
<body>
<form class="box" method="POST" action="/login">
<h1>n3xn</h1>
<p>Private access</p>
${error ? `<div class="err">${error}</div>` : ""}
<input name="password" type="password" autocomplete="current-password"
  placeholder="Password" autofocus required>
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

/* ------------------------------------------------------------------ */
/* Session helpers                                                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* HTML injection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Inject DevTools into an HTML document.
 * Tries </body>, then </html>, then appends.
 * Also injects a small early bootstrap in <head> so the panel
 * can reserve space before the full script loads.
 */
function injectDevTools(html) {
  const scriptTag =
    `<script src="${DEVTOOLS_SCRIPT}" defer crossorigin="anonymous"></script>`;

  // Early style so the page can shift when the sidebar opens
  // (avoids a flash of full-width content)
  const earlyStyle = `<style id="n3xn-devtools-early">
html.n3xn-devtools-open{margin-right:var(--n3xn-sidebar-width,420px)!important;transition:margin-right .15s ease}
html.n3xn-devtools-open body{max-width:100%}
</style>`;

  let out = html;

  // Prefer injecting the early style into <head>
  if (/<\/head\s*>/i.test(out)) {
    out = out.replace(/<\/head\s*>/i, `${earlyStyle}</head>`);
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${earlyStyle}`);
  } else {
    out = earlyStyle + out;
  }

  // Script as late as possible so the DOM is ready
  if (/<\/body\s*>/i.test(out)) {
    out = out.replace(/<\/body\s*>/i, `${scriptTag}</body>`);
  } else if (/<\/html\s*>/i.test(out)) {
    out = out.replace(/<\/html\s*>/i, `${scriptTag}</html>`);
  } else {
    out += scriptTag;
  }

  return out;
}

function isHtmlResponse(response, url) {
  const ct = (response.headers.get("Content-Type") || "").toLowerCase();

  // Explicit HTML
  if (ct.includes("text/html")) return true;

  // Some servers omit Content-Type or send application/xhtml+xml
  if (ct.includes("application/xhtml")) return true;

  // Empty / missing type on navigations that look like documents
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

function shouldSkipInjection(url) {
  const p = url.pathname.toLowerCase();
  // Never inject into the DevTools assets themselves
  if (p.endsWith("/devtools.js") || p.endsWith("/devtools.css")) return true;
  if (p === "/devtools-auth") return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Main handler                                                        */
/* ------------------------------------------------------------------ */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  /* ---- Login ---- */
  if (url.pathname === "/login") {
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

  /* ---- Logout ---- */
  if (url.pathname === "/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login",
        "Set-Cookie":
          `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  }

  /* ---- DevTools auth endpoint (handled by its own function) ---- */
  if (url.pathname === "/devtools-auth") {
    return context.next();
  }

  /* ---- Require session for everything else ---- */
  const authenticated = await checkSession(
    request,
    env.N3XN_SESSION_SECRET,
  );
  if (!authenticated) return loginPage();

  /* ---- Proxy / next ---- */
  const response = await context.next();

  /* ---- Only touch HTML-like responses ---- */
  if (shouldSkipInjection(url) || !isHtmlResponse(response, url)) {
    return response;
  }

  let body;
  try {
    body = await response.text();
  } catch {
    return response;
  }

  // Avoid double-injection
  if (
    body.includes("devtools.js") &&
    body.includes("raw.githubusercontent.com/kbsigmaboy67AtSchool")
  ) {
    return response;
  }

  const injected = injectDevTools(body);

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  // Proxied sites often ship CSP that blocks our script host
  headers.delete("Content-Security-Policy");
  headers.delete("Content-Security-Policy-Report-Only");
  // Make sure browsers treat it as HTML
  if (!headers.get("Content-Type")?.toLowerCase().includes("html")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
  }

  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
