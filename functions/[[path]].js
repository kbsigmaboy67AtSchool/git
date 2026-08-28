export async function onRequest({ request }) {
  const url = new URL(request.url);
  const cookies = request.headers.get("Cookie") || "";

  let user = cookies.match(/(?:^|;\s*)github_user=([^;]+)/)?.[1];

  // Bootstrap: /octocat/foo/bar -> /foo/bar
  const parts = url.pathname.split("/").filter(Boolean);

  if (!user && parts.length >= 1) {
    user = parts.shift();

    if (!/^[A-Za-z0-9-]+$/.test(user)) {
      return new Response("Invalid GitHub username", { status: 400 });
    }

    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/" + parts.join("/") + url.search,
        "Set-Cookie": `github_user=${user}; Path=/; Secure; SameSite=Lax`,
      },
    });
  }

  if (!user) {
    return new Response("No GitHub user selected", { status: 400 });
  }

  // Fetch the actual GitHub Pages resource.
  const target = `https://${user}.github.io${url.pathname}${url.search}`;

  const upstream = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : request.body,
    redirect: "follow",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
