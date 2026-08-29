const SESSION_COOKIE = "n3xn_session";
const SESSION_TTL = 60 * 60 * 24 * 30;

const DEVTOOLS_SCRIPT =
  "https://raw.githubusercontent.com/kbsigmaboy67AtSchool/git/main/public/devtools.js";

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
    String.fromCharCode(
      ...new Uint8Array(signature),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function checkSession(request, secret) {
  if (!secret) return false;

  const cookies =
    request.headers.get("Cookie") || "";

  const token =
    cookies.match(
      /(?:^|;\s*)n3xn_session=([^;]+)/,
    )?.[1];

  if (!token) return false;

  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [expires, signature] = parts;

  if (!/^\d+$/.test(expires)) {
    return false;
  }

  if (
    Number(expires) <
    Math.floor(Date.now() / 1000)
  ) {
    return false;
  }

  const expected =
    await makeSignature(
      expires,
      secret,
    );

  return signature === expected;
}

function sessionCookie(
  expires,
  signature,
) {
  return [
    `${SESSION_COOKIE}=${expires}.${signature}`,
    "Path=/",
    `Max-Age=${SESSION_TTL}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

export async function onRequest(context) {
  const {
    request,
    env,
  } = context;

  const url =
    new URL(request.url);

  /*
   * LOGIN
   */

  if (url.pathname === "/login") {
    if (request.method === "GET") {
      return loginPage();
    }

    if (request.method === "POST") {
      const form =
        await request.formData();

      const supplied =
        String(
          form.get("password") || "",
        );

      if (
        !env.N3XN_PASSWORD ||
        supplied !==
          env.N3XN_PASSWORD
      ) {
        return loginPage(
          "Incorrect password.",
        );
      }

      if (
        !env.N3XN_SESSION_SECRET
      ) {
        return new Response(
          "N3XN_SESSION_SECRET is missing.",
          {
            status: 500,
          },
        );
      }

      const expires =
        Math.floor(
          Date.now() / 1000,
        ) + SESSION_TTL;

      const signature =
        await makeSignature(
          String(expires),
          env.N3XN_SESSION_SECRET,
        );

      return new Response(
        null,
        {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie":
              sessionCookie(
                expires,
                signature,
              ),
          },
        },
      );
    }

    return new Response(
      "Method Not Allowed",
      {
        status: 405,
      },
    );
  }

  /*
   * LOGOUT
   */

  if (url.pathname === "/logout") {
    return new Response(
      null,
      {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie":
            `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
        },
      },
    );
  }

  /*
   * DEVTOOLS AUTH
   */

  if (
    url.pathname === "/devtools-auth"
  ) {
    return context.next();
  }

  /*
   * REQUIRE NORMAL LOGIN
   */

  const authenticated =
    await checkSession(
      request,
      env.N3XN_SESSION_SECRET,
    );

  if (!authenticated) {
    return loginPage();
  }

  /*
   * RUN THE ACTUAL FUNCTION
   */

  const response =
    await context.next();

  /*
   * ONLY MODIFY HTML
   */

  const contentType =
    response.headers.get(
      "Content-Type",
    ) || "";

  const isHTML =
    contentType
      .toLowerCase()
      .includes("text/html");

  if (!isHTML) {
    return response;
  }

  /*
   * Don't inject into the script itself.
   */

  if (
    url.pathname ===
    "/devtools.js"
  ) {
    return response;
  }

  let body;

  try {
    body =
      await response.text();
  } catch {
    return response;
  }

  /*
   * ABSOLUTE GITHUB PAGES SCRIPT
   */

  const injection =
    `<script src="${DEVTOOLS_SCRIPT}" defer></script>`;

  /*
   * Put it inside the document when possible.
   */

  if (
    /<\/body\s*>/i.test(body)
  ) {
    body =
      body.replace(
        /<\/body\s*>/i,
        `${injection}</body>`,
      );
  } else if (
    /<\/html\s*>/i.test(body)
  ) {
    body =
      body.replace(
        /<\/html\s*>/i,
        `${injection}</html>`,
      );
  } else {
    body += injection;
  }

  const headers =
    new Headers(
      response.headers,
    );

  /*
   * Body was changed.
   */

  headers.delete(
    "Content-Length",
  );

  headers.delete(
    "Content-Encoding",
  );

  /*
   * The proxied site may have a CSP that
   * blocks GitHub Pages scripts.
   *
   * Remove the response CSP so the
   * explicitly injected DevTools script
   * can execute.
   */

  headers.delete(
    "Content-Security-Policy",
  );

  headers.delete(
    "Content-Security-Policy-Report-Only",
  );

  return new Response(
    body,
    {
      status:
        response.status,
      statusText:
        response.statusText,
      headers,
    },
  );
}
