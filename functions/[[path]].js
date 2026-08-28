export async function onRequest({ request }) {
  const url = new URL(request.url);

  /*
   * =========================================================
   * EXPLICIT DOMAIN MODE
   * =========================================================
   *
   * The middleware converts:
   *
   * /example.com/foo/bar
   *
   * into:
   *
   * /foo/bar
   *
   * and gives us the domain through X-Proxy-Domain.
   */

  const explicitDomain = request.headers.get("X-Proxy-Domain");

  if (explicitDomain) {
    /*
     * Validate the domain.
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

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  /*
   * =========================================================
   * USER SWITCH MODE
   * =========================================================
   *
   * ONLY /$/USERNAME changes the GitHub user.
   *
   * Examples:
   *
   * /$/kbsigmaboy67
   * /$/kbsigmaboy67/foo
   * /$/kbsigmaboy67/api/test
   */

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "$") {
    /*
     * We need a username after "$".
     */
    if (!parts[1]) {
      return new Response("Missing GitHub username", {
        status: 400,
      });
    }

    const user = parts[1];

    /*
     * GitHub usernames may contain letters, numbers and hyphens.
     */
    if (!/^[A-Za-z0-9-]+$/.test(user)) {
      return new Response("Invalid GitHub username", {
        status: 400,
      });
    }

    /*
     * Remove:
     *
     * /$/
     * username
     *
     * leaving only the actual path.
     */
    const remainingParts = parts.slice(2);

    const newPath =
      remainingParts.length > 0
        ? "/" + remainingParts.join("/")
        : "/";

    /*
     * Store the selected user and redirect to the clean path.
     *
     * /$/kbsigmaboy67/foo
     *
     * becomes:
     *
     * /foo
     *
     * with github_user=kbsigmaboy67.
     */
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

  /*
   * =========================================================
   * CURRENT USER MODE
   * =========================================================
   *
   * Everything that isn't:
   *
   * /$/USERNAME
   *
   * uses the currently selected GitHub user.
   */

  const cookies = request.headers.get("Cookie") || "";

  const user = cookies.match(
    /(?:^|;\s*)github_user=([^;]+)/
  )?.[1];

  if (!user) {
    return new Response("No GitHub user selected", {
      status: 400,
    });
  }

  /*
   * =========================================================
   * GITHUB PAGES PROXY
   * =========================================================
   *
   * /foo/bar
   *
   * becomes:
   *
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
