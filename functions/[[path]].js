export async function onRequest({ request }) {
  const url = new URL(request.url);

  /*
   * =========================================================
   * EXPLICIT DOMAIN MODE
   * =========================================================
   *
   * The middleware detects:
   *
   * /example.com/foo/bar
   *
   * and changes it internally to:
   *
   * /foo/bar
   *
   * while putting "example.com" in X-Proxy-Domain.
   */
  const explicitDomain = request.headers.get("X-Proxy-Domain");

  if (explicitDomain) {
    /*
     * Validate the domain before fetching it.
     *
     * Allows:
     * example.com
     * www.example.com
     * api.example.co.uk
     */
    if (
      !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
        explicitDomain
      )
    ) {
      return new Response("Invalid domain", {
        status: 400,
      });
    }

    const target = new URL(`https://${explicitDomain}`);

    target.pathname = url.pathname || "/";
    target.search = url.search;

    const headers = new Headers(request.headers);

    // Internal routing header must not reach the upstream server.
    headers.delete("X-Proxy-Domain");
    headers.delete("Host");

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : request.body,
      redirect: "follow",
    });

    /*
     * Pass the upstream response back unchanged.
     */
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  /*
   * =========================================================
   * GITHUB USER MODE
   * =========================================================
   *
   * No "." in the first segment means normal username logic.
   *
   * /username/foo/bar
   *       ↓
   * https://username.github.io/foo/bar
   */

  const cookies = request.headers.get("Cookie") || "";

  const cookieUser = cookies.match(
    /(?:^|;\s*)github_user=([^;]+)/
  )?.[1];

  const parts = url.pathname.split("/").filter(Boolean);

  let user = cookieUser;

  /*
   * If the first path component looks like a GitHub username,
   * allow it to explicitly change the current user.
   *
   * This is what lets you switch users even when a cookie
   * already exists.
   *
   * /newuser/foo
   *       ↓
   * github_user = newuser
   *       ↓
   * /foo
   */
  if (parts.length > 0) {
    const possibleUser = parts[0];

    if (
      !possibleUser.includes(".") &&
      /^[A-Za-z0-9-]+$/.test(possibleUser)
    ) {
      /*
       * Treat the first component as a username when it is
       * explicitly being supplied in the URL.
       */
      user = possibleUser;

      parts.shift();

      const newPath =
        parts.length > 0
          ? "/" + parts.join("/")
          : "/";

      return new Response(null, {
        status: 302,
        headers: {
          Location: newPath + url.search,

          "Set-Cookie":
            `github_user=${encodeURIComponent(user)}; ` +
            `Path=/; Secure; SameSite=Lax`,
        },
      });
    }
  }

  /*
   * No username was supplied in the URL and no cookie exists.
   */
  if (!user) {
    return new Response("No GitHub user selected", {
      status: 400,
    });
  }

  /*
   * =========================================================
   * PROXY TO GITHUB PAGES
   * =========================================================
   *
   * /foo/bar
   *     ↓
   * https://USER.github.io/foo/bar
   */

  const target = new URL(`https://${user}.github.io`);

  target.pathname = url.pathname || "/";
  target.search = url.search;

  const headers = new Headers(request.headers);

  headers.delete("Host");
  headers.delete("X-Proxy-Domain");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
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
