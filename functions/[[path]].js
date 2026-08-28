// functions/[[path]].js

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  // /octocat/foo/bar -> remember "octocat", then go to /foo/bar
  if (parts.length >= 2 && !request.headers.get("Cookie")?.includes("github_user=")) {
    const user = parts.shift();

    if (!/^[A-Za-z0-9-]+$/.test(user)) {
      return new Response("Invalid GitHub username", { status: 400 });
    }

    const newPath = "/" + parts.join("/");

    return new Response(null, {
      status: 302,
      headers: {
        "Location": newPath + url.search,
        "Set-Cookie": `github_user=${user}; Path=/; Secure; SameSite=Lax`,
      },
    });
  }

  // Read remembered user
  const match = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)github_user=([^;]+)/);

  const user = match?.[1];

  if (!user) {
    return new Response("No GitHub user selected. Try /octocat/foo", {
      status: 400,
    });
  }

  return new Response(JSON.stringify({
    github_user: user,
    path: url.pathname,
    query: url.search,
    upstream: `https://${user}.github.io${url.pathname}${url.search}`,
  }, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
