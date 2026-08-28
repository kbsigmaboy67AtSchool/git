export async function onRequest({ request }) {
  const url = new URL(request.url);
  const cookie = request.headers.get("Cookie") || "";

  let user = cookie.match(/(?:^|;\s*)github_user=([^;]+)/)?.[1];

  // First visit: /username/anything
  if (!user) {
    const parts = url.pathname.split("/").filter(Boolean);

    if (!parts.length) {
      return new Response("Use /githubusername/path", { status: 400 });
    }

    user = parts.shift();

    if (!/^[A-Za-z0-9-]+$/.test(user)) {
      return new Response("Invalid GitHub username", { status: 400 });
    }

    const newPath = "/" + parts.join("/");

    return new Response(null, {
      status: 302,
      headers: {
        "Location": newPath + url.search,
        "Set-Cookie":
          `github_user=${user}; Path=/; Secure; SameSite=Lax`,
      },
    });
  }

  // Everything after the bootstrap redirect uses the
  // remembered GitHub user as the upstream host.
  const target = new URL(`https://${user}.github.io`);
  target.pathname = url.pathname;
  target.search = url.search;

  const headers = new Headers(request.headers);
  headers.delete("Host");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : request.body,
    redirect: "manual",
  });

  // Pass the GitHub response straight back.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
