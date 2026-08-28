export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const parts = url.pathname.split("/").filter(Boolean);

  // Nothing to inspect.
  if (parts.length === 0) {
    return context.next();
  }

  const first = parts[0];

  /*
   * If the first path segment contains a dot,
   * treat it as an explicit domain.
   *
   * /example.com/foo/bar
   *        ↓
   * https://example.com/foo/bar
   *
   * /sub.example.com/api/test
   *        ↓
   * https://sub.example.com/api/test
   */
  if (first.includes(".")) {
    const domain = first;

    const remainingParts = parts.slice(1);
    const remainingPath =
      remainingParts.length > 0
        ? "/" + remainingParts.join("/")
        : "/";

    const rewrittenUrl = new URL(url);
    rewrittenUrl.pathname = remainingPath;

    const headers = new Headers(request.headers);

    // Tell [[path]].js which domain to proxy to.
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
   * No ".":
   *
   * Let [[path]].js handle normal GitHub-user logic.
   */
  return context.next();
}
