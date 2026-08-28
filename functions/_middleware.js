export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const parts = url.pathname.split("/").filter(Boolean);

  /*
   * Explicit domain mode:
   *
   * /example.com/path
   * /www.example.com/path
   *
   * A "." in the first path segment means that the
   * first segment is a domain rather than a GitHub user.
   */
  if (parts.length > 0 && parts[0].includes(".")) {
    const domain = parts[0];

    const remainingParts = parts.slice(1);
    const remainingPath =
      remainingParts.length > 0
        ? "/" + remainingParts.join("/")
        : "/";

    const rewrittenUrl = new URL(url);
    rewrittenUrl.pathname = remainingPath;

    const headers = new Headers(request.headers);

    headers.set("X-Proxy-Domain", domain);

    const rewrittenRequest = new Request(rewrittenUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : request.body,
      redirect: "manual",
    });

    return context.next(rewrittenRequest);
  }

  /*
   * Everything else is handled by [[path]].js.
   *
   * In particular:
   *
   * /foo
   * /foo/bar
   * /api/test
   * /payload
   *
   * are NOT usernames.
   */
  return context.next();
}
