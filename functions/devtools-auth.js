```js
function unauthorized() {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "DevTools authentication required",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Method Not Allowed",
      }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }

  /*
   * Require the normal n3xn login session first.
   */

  const cookies =
    request.headers.get("Cookie") || "";

  if (!cookies.includes("n3xn_session=")) {
    return unauthorized();
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Invalid JSON",
      }),
      {
        status: 400,
        headers: {
          "Content-Type":
            "application/json",
        },
      },
    );
  }

  /*
   * Only the DevTools password is accepted here.
   * It is NEVER embedded into devtools.js.
   */

  if (
    !env.N3XN_DEVTOOLS_PASSWORD ||
    body.password !==
      env.N3XN_DEVTOOLS_PASSWORD
  ) {
    return unauthorized();
  }

  return new Response(
    JSON.stringify({
      ok: true,
      capabilities: {
        console: true,
        sourceRewrite: true,
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
```
