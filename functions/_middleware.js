
const SESSION_COOKIE = "n3xn_session";
const SESSION_TTL = 60 * 60 * 24 * 30;

function loginPage(error = "") {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>n3xn — Private</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%}
body{
  display:grid;
  place-items:center;
  background:#080a0f;
  color:#e6edf3;
  font-family:system-ui,-apple-system,sans-serif
}
.box{
  width:min(390px,calc(100vw - 32px));
  padding:30px;
  border:1px solid #30363d;
  border-radius:14px;
  background:#0d1117;
  box-shadow:0 20px 60px #0008
}
h1{margin:0 0 6px;font-size:24px}
p{margin:0 0 22px;color:#8b949e}
input{
  width:100%;
  padding:12px;
  margin-bottom:10px;
  border:1px solid #30363d;
  border-radius:7px;
  outline:none;
  background:#010409;
  color:#fff;
  font:inherit
}
input:focus{border-color:#58a6ff}
button{
  width:100%;
  padding:12px;
  border:0;
  border-radius:7px;
  background:#238636;
  color:#fff;
  font-weight:600;
  cursor:pointer
}
.err{
  margin-bottom:12px;
  color:#ff7b72
}
</style>
</head>
<body>
<form class="box" method="POST" action="/login">
<h1>n3xn</h1>
<p>Private access</p>
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

async function makeSignature(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );

  return btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function checkSession(request, secret) {
  if (!secret) return false;

  const cookies = request.headers.get("Cookie") || "";

  const token = cookies.match(
    /(?:^|;\s*)n3xn_session=([^;]+)/,
  )?.[1];

  if (!token) return false;

  const split = token.split(".");

  if (split.length !== 2) return false;

  const [expires, signature] = split;

  if (!/^\d+$/.test(expires)) return false;

  if (
    Number(expires) <
    Math.floor(Date.now() / 1000)
  ) {
    return false;
  }

  const expected = await makeSignature(
    expires,
    secret,
  );

  return signature === expected;
}

function sessionCookie(expires, signature) {
  return [
    `n3xn_session=${expires}.${signature}`,
    "Path=/",
    `Max-Age=${SESSION_TTL}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  /*
   * PUBLIC AUTH ROUTES
   */

  if (url.pathname === "/login") {
    if (request.method === "GET") {
      return loginPage();
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const supplied = String(
        form.get("password") || "",
      );

      if (
        !env.N3XN_PASSWORD ||
        supplied !== env.N3XN_PASSWORD
      ) {
        return loginPage("Incorrect password.");
      }

      if (!env.N3XN_SESSION_SECRET) {
        return new Response(
          "N3XN_SESSION_SECRET is missing.",
          { status: 500 },
        );
      }

      const expires =
        Math.floor(Date.now() / 1000) +
        SESSION_TTL;

      const signature =
        await makeSignature(
          String(expires),
          env.N3XN_SESSION_SECRET,
        );

      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": sessionCookie(
            expires,
            signature,
          ),
        },
      });
    }

    return new Response(
      "Method Not Allowed",
      { status: 405 },
    );
  }

  if (url.pathname === "/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login",
        "Set-Cookie":
          "n3xn_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
      },
    });
  }

  /*
   * DEVTOOLS AUTH ENDPOINT IS HANDLED SEPARATELY.
   */

  if (url.pathname === "/devtools-auth") {
    return context.next();
  }

  /*
   * EVERYTHING ELSE REQUIRES THE APP LOGIN.
   */

  const authenticated = await checkSession(
    request,
    env.N3XN_SESSION_SECRET,
  );

  if (!authenticated) {
    return loginPage();
  }

  const response = await context.next();

  /*
   * Inject only into actual HTML documents/iframes.
   *
   * fetch()/XHR responses aren't injected.
   */

  const destination =
    request.headers.get("Sec-Fetch-Dest") || "";

  const contentType =
    response.headers.get("Content-Type") || "";

  const isDocument =
    destination === "document" ||
    destination === "iframe";

  const isHTML =
    contentType
      .toLowerCase()
      .includes("text/html");

  if (isDocument && isHTML) {
    const body = await response.text();

    const injection =
      `<script src="/devtools.js" defer></script>`;

    const output =
      /<\/body>/i.test(body)
        ? body.replace(
            /<\/body>/i,
            `${injection}</body>`,
          )
        : body + injection;

    const headers =
      new Headers(response.headers);

    headers.delete("Content-Length");

    return new Response(output, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}
