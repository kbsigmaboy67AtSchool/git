export async function onRequest({ request }) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  /*
   * =========================================================
   * SPECIAL $ ROUTING
   * =========================================================
   *
   * /$/target
   *
   * The first component after "$" is the target.
   *
   * If it contains a ".", it is treated as a domain.
   *
   * Otherwise it is treated as a GitHub username.
   *
   * Examples:
   *
   * /$/kbsigmaboy67
   * /$/kbsigmaboy67/foo
   *
   * /$/example.com
   * /$/example.com/foo
   */

  if (parts[0] === "$") {
    const targetName = parts[1];

    if (!targetName) {
      return new Response("Missing user or domain", {
        status: 400,
      });
    }

    const remainingParts = parts.slice(2);

    const targetPath =
      remainingParts.length > 0
        ? "/" + remainingParts.join("/")
        : "/";

    /*
     * -------------------------------------------------------
     * DOMAIN OVERRIDE
     * -------------------------------------------------------
     */

    if (targetName.includes(".")) {
      /*
       * Validate domain.
       */
      if (
        !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
          targetName
        )
      ) {
        return new Response("Invalid domain", {
          status: 400,
        });
      }

      /*
       * Save the explicit domain in a cookie.
       *
       * This means subsequent normal requests such as
       *
       * /themes.css
       *
       * continue using this domain.
       */
      const target = new URL(`https://${targetName}`);

      target.pathname = targetPath;
      target.search = url.search;

      const headers = new Headers(request.headers);

      headers.delete("Host");

      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        redirect: "follow",
      });

      const responseHeaders = new Headers(upstream.headers);

      responseHeaders.append(
        "Set-Cookie",
        `proxy_domain=${encodeURIComponent(targetName)}; Path=/; Secure; SameSite=Lax`
      );

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    /*
     * -------------------------------------------------------
     * GITHUB USER OVERRIDE
     * -------------------------------------------------------
     */

    if (!/^[A-Za-z0-9-]+$/.test(targetName)) {
      return new Response("Invalid GitHub username", {
        status: 400,
      });
    }

    const target = new URL(
      `https://${targetName}.github.io`
    );

    target.pathname = targetPath;
    target.search = url.search;

    const headers = new Headers(request.headers);

    headers.delete("Host");

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : request.body,
      redirect: "follow",
    });

    const responseHeaders = new Headers(upstream.headers);

    responseHeaders.append(
      "Set-Cookie",
      `github_user=${encodeURIComponent(targetName)}; Path=/; Secure; SameSite=Lax`
    );

    /*
     * Once a GitHub user is selected, remove any previous
     * explicit domain.
     */
    responseHeaders.append(
      "Set-Cookie",
      "proxy_domain=; Path=/; Max-Age=0; Secure; SameSite=Lax"
    );

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  /*
   * =========================================================
   * NORMAL REQUEST
   * =========================================================
   *
   * Everything that does NOT begin with /$/
   * is simply forwarded to the currently selected target.
   *
   * Examples:
   *
   * /themes.css
   * /index.html
   * /foo/bar
   * /api/test
   */

  const cookies = request.headers.get("Cookie") || "";

  const user = cookies.match(
    /(?:^|;\s*)github_user=([^;]+)/
  )?.[1];

  const domain = cookies.match(
    /(?:^|;\s*)proxy_domain=([^;]+)/
  )?.[1];

  /*
   * Prefer an explicitly selected domain.
   */
  if (domain) {
    let decodedDomain;

    try {
      decodedDomain = decodeURIComponent(domain);
    } catch {
      return new Response("Invalid saved domain", {
        status: 400,
      });
    }

    if (
      !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
        decodedDomain
      )
    ) {
      return new Response("Invalid saved domain", {
        status: 400,
      });
    }

    const target = new URL(`https://${decodedDomain}`);

    target.pathname = url.pathname || "/";
    target.search = url.search;

    const headers = new Headers(request.headers);

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
   * Otherwise use the selected GitHub user.
   */
  if (user) {
    let decodedUser;

    try {
      decodedUser = decodeURIComponent(user);
    } catch {
      return new Response("Invalid saved GitHub username", {
        status: 400,
      });
    }

    if (!/^[A-Za-z0-9-]+$/.test(decodedUser)) {
      return new Response("Invalid saved GitHub username", {
        status: 400,
      });
    }

    const target = new URL(
      `https://${decodedUser}.github.io`
    );

    target.pathname = url.pathname || "/";
    target.search = url.search;

    const headers = new Headers(request.headers);

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
   * Nothing has been selected yet.
   */
  return new Response("No user or domain selected", {
    status: 400,
  });
}
