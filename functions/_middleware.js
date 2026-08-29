```js
const SESSION_COOKIE = "n3xn_session";
const SESSION_TTL = 60 * 60 * 24 * 30;

async function sign(value, secret) {
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

async function validSession(request, secret) {
  if (!secret) return false;

  const cookie = request.headers.get("Cookie") || "";
  const token = cookie.match(
    /(?:^|;\s*)n3xn_session=([^;]+)/,
  )?.[1];

  if (!token) return false;

  const [expires, signature] = token.split(".");

  if (
    !expires ||
    !signature ||
    !/^\d+$/.test(expires) ||
    Number(expires) < Math.floor(Date.now() / 1000)
  ) {
    return false;
  }

  const expected = await sign(expires, secret);

  return signature === expected;
}

function loginPage(error = "") {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>n3xn — Login</title>
<style>
html,body{height:100%;margin:0}
body{
  display:grid;
  place-items:center;
  background:#080b10;
  color:#e6edf3;
  font:15px system-ui,sans-serif
}
.box{
  width:min(380px,calc(100vw - 40px));
  padding:28px;
  border:1px solid #30363d;
  border-radius:12px;
  background:#0d1117;
  box-sizing:border-box
}
h1{margin:0 0 8px}
p{color:#8b949e}
input,button{
  width:100%;
  box-sizing:border-box;
  padding:11px;
  border-radius:7px;
  font:inherit
}
input{
  background:#010409;
  color:#fff;
  border:1px solid #30363d;
  margin-bottom:10px
}
button{
  border:0;
  background:#238636;
  color:#fff;
  cursor:pointer;
  font-weight:600
}
.err{color:#ff7b72;margin-bottom:12px}
</style>
</head>
<body>
<main class="box">
<h1>n3xn</h1>
<p>Private access</p>

<form method="POST" action="/login">
${error ? `<div class="err">${error}</div>` : ""}
<input
  name="password"
  type="password"
  autocomplete="current-password"
  placeholder="Password"
  autofocus
  required
>
<button type="submit">Continue</button>
</form>

</main>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const password = env.N3XN_PASSWORD;
  const sessionSecret = env.N3XN_SESSION_SECRET;

  /*
   * LOGIN
   */

  if (url.pathname === "/login") {
    if (request.method === "GET") {
      return loginPage();
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const supplied = String(form.get("password") || "");

      if (!password || supplied !== password) {
        return loginPage("Incorrect password.");
      }

      if (!sessionSecret) {
        return new Response(
          "N3XN_SESSION_SECRET is not configured.",
          { status: 500 },
        );
      }

      const expires =
        Math.floor(Date.now() / 1000) + SESSION_TTL;

      const signature = await sign(
        String(expires),
        sessionSecret,
      );

      const headers = new Headers({
        Location: "/",
      });

      headers.append(
        "Set-Cookie",
        `${SESSION_COOKIE}=${expires}.${signature}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`,
      );

      return new Response(null, {
        status: 303,
        headers,
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
    });
  }

  /*
   * LOGOUT
   */

  if (url.pathname === "/logout") {
    const headers = new Headers({
      Location: "/login",
    });

    headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    );

    return new Response(null, {
      status: 303,
      headers,
    });
  }

  /*
   * EVERYTHING ELSE REQUIRES LOGIN
   */

  if (!(await validSession(request, sessionSecret))) {
    return loginPage();
  }

  /*
   * LET THE ACTUAL FUNCTION HANDLE THE REQUEST
   */

  const response = await context.next();

  /*
   * DEVTOOLS INJECTION
   *
   * Only inject into:
   *
   *   document
   *   iframe
   *
   * HTML responses.
   *
   * fetch()/XHR responses don't normally have these
   * Sec-Fetch-Dest values, so they aren't modified.
   */

  const destination =
    request.headers.get("Sec-Fetch-Dest") || "";

  const contentType =
    response.headers.get("Content-Type") || "";

  if (
    (destination === "document" ||
      destination === "iframe") &&
    contentType.toLowerCase().includes("text/html")
  ) {
    const body = await response.text();

    const injected =
      body.replace(
        /<\/body>/i,
        `<script src="/devtools.js" defer></script></body>`,
      );

    const headers = new Headers(response.headers);

    headers.delete("Content-Length");
    headers.set("Cache-Control", "no-store");

    return new Response(injected, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}
```
