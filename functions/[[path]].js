
/*
 * n3xn Cloudflare Pages proxy
 *
 * Main proxy + HTML rewriter.
 *
 * =========================================================
 * EASY HEADER CONFIGURATION
 * =========================================================
 *
 * Change these arrays/objects to control upstream response
 * headers.
 *
 * "remove" = headers removed from upstream responses.
 *
 * "set" = headers forcibly added/replaced.
 *
 * "preserve" = headers that are explicitly allowed to survive
 * even if they would otherwise be removed.
 *
 * Header names are case-insensitive.
 */

const HEADER_POLICY = {
  remove: [
    // Prevent upstream pages from blocking iframe embedding.
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",

    // These become invalid after HTML rewriting.
    "content-length",
    "content-encoding",

    // Upstream caching can sometimes cause stale rewritten pages.
    // Remove this if you want to keep the upstream Cache-Control.
    // "cache-control",
  ],

  set: {
    /*
     * Example:
     *
     * "cross-origin-resource-policy": "cross-origin",
     *
     * Leave empty unless you specifically want to force a header.
     */
  },

  preserve: [
    /*
     * Example:
     *
     * "cache-control",
     */
  ],
};


/*
 * =========================================================
 * GENERAL HELPERS
 * =========================================================
 */

function cleanResponseHeaders(input) {
  const headers = new Headers(input);

  const remove = new Set(
    HEADER_POLICY.remove.map((x) => x.toLowerCase()),
  );

  const preserve = new Set(
    HEADER_POLICY.preserve.map((x) => x.toLowerCase()),
  );

  /*
   * Remove configured headers unless explicitly preserved.
   */
  for (const name of remove) {
    if (!preserve.has(name)) {
      headers.delete(name);
    }
  }

  /*
   * Apply forced headers.
   */
  for (const [name, value] of Object.entries(HEADER_POLICY.set)) {
    headers.set(name, value);
  }

  return headers;
}


/*
 * Convert an upstream URL into a proxy URL.
 *
 * Same-origin resources remain relative to the current proxy.
 *
 * Cross-origin HTTP(S) resources become:
 *
 * /$/example.com/path
 *
 * This means if an iframe or script points somewhere else,
 * the browser still goes through the proxy.
 */
function proxyResourceUrl(resource, upstreamBase, proxyBase) {
  const value = String(resource || "").trim();

  if (!value) return value;

  /*
   * Do not touch fragments or browser-only schemes.
   */
  if (
    value.startsWith("#") ||
    /^(?:data|blob|javascript|mailto|tel|about|file):/i.test(value)
  ) {
    return value;
  }

  let absolute;

  try {
    absolute = new URL(value, upstreamBase);
  } catch {
    return value;
  }

  /*
   * HTTP(S) only.
   */
  if (
    absolute.protocol !== "http:" &&
    absolute.protocol !== "https:"
  ) {
    return value;
  }

  /*
   * Same upstream origin.
   *
   * Keep it on the current proxy URL.
   */
  if (absolute.origin === upstreamBase.origin) {
    return (
      absolute.pathname +
      absolute.search +
      absolute.hash
    );
  }

  /*
   * Cross-origin resource.
   */
  return (
    `/$/${absolute.host}` +
    `${absolute.pathname || "/"}` +
    `${absolute.search}` +
    `${absolute.hash}`
  );
}


/*
 * Rewrite Location headers from upstream redirects.
 *
 * This is particularly important for iframe navigation:
 *
 * Upstream:
 *   Location: https://example.com/login
 *
 * becomes:
 *   Location: /$/example.com/login
 */
function rewriteLocationHeader(headers, upstreamBase, proxyBase) {
  const location = headers.get("Location");

  if (!location) return;

  try {
    const rewritten = proxyResourceUrl(
      location,
      upstreamBase,
      proxyBase,
    );

    headers.set("Location", rewritten);
  } catch {
    /*
     * Leave malformed Location headers alone.
     */
  }
}


/*
 * Rewrite upstream Set-Cookie headers so cookies belong to
 * the proxy rather than the original hostname.
 */
function rewriteSetCookies(headers) {
  /*
   * Cloudflare's Headers implementation supports getSetCookie()
   * in current Workers runtimes.
   */
  const getCookies = headers.getSetCookie;

  if (typeof getCookies !== "function") {
    return;
  }

  const cookies = getCookies.call(headers);

  if (!cookies || cookies.length === 0) {
    return;
  }

  headers.delete("Set-Cookie");

  for (let cookie of cookies) {
    /*
     * Remove the upstream Domain attribute.
     */
    cookie = cookie.replace(
      /;\s*Domain=[^;]*/gi,
      "",
    );

    /*
     * Normalize Path.
     */
    if (/;\s*Path=/i.test(cookie)) {
      cookie = cookie.replace(
        /;\s*Path=[^;]*/gi,
        "; Path=/",
      );
    } else {
      cookie += "; Path=/";
    }

    headers.append("Set-Cookie", cookie);
  }
}


/*
 * Determine whether the upstream response is HTML.
 */
function isHtmlResponse(response, target) {
  const type = (
    response.headers.get("Content-Type") || ""
  ).toLowerCase();

  if (
    type.includes("text/html") ||
    type.includes("application/xhtml+xml")
  ) {
    return true;
  }

  /*
   * Some badly configured sites return HTML as text/plain.
   */
  if (!type || type === "text/plain") {
    const path = target.pathname.toLowerCase();

    return (
      path === "/" ||
      path.endsWith(".html") ||
      path.endsWith(".htm") ||
      path.endsWith("/") ||
      !path.includes(".")
    );
  }

  return false;
}


/*
 * =========================================================
 * HTML REWRITER
 * =========================================================
 */

function rewriteHtml(response, target, proxyBase) {
  const headers = cleanResponseHeaders(
    response.headers,
  );

  rewriteSetCookies(headers);

  rewriteLocationHeader(
    headers,
    target,
    proxyBase,
  );

  headers.set(
    "Content-Type",
    "text/html; charset=utf-8",
  );

  /*
   * Because HTMLRewriter changes the body, compressed upstream
   * data and its original Content-Length cannot be reused.
   */
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");

  const rewriter = new HTMLRewriter();


  /*
   * ---------------------------------------------------------
   * Standard URL-bearing attributes
   * ---------------------------------------------------------
   *
   * iframe is intentionally included first.
   */
  const attributes = [
    ["iframe", "src"],
    ["frame", "src"],

    ["object", "data"],
    ["embed", "src"],

    ["script", "src"],

    ["link", "href"],

    ["img", "src"],
    ["image", "href"],
    ["image", "xlink:href"],

    ["source", "src"],
    ["track", "src"],

    ["video", "src"],
    ["audio", "src"],

    ["input", "src"],
    ["input", "formaction"],

    ["button", "formaction"],

    ["form", "action"],

    ["a", "href"],
    ["area", "href"],

    ["base", "href"],

    ["meta", "content"],
  ];


  for (const [selector, attribute] of attributes) {
    rewriter.on(selector, {
      element(element) {
        const value = element.getAttribute(
          attribute,
        );

        if (!value) return;

        const trimmed = value.trim();

        /*
         * Don't rewrite browser-local values.
         */
        if (
          !trimmed ||
          trimmed.startsWith("#") ||
          /^(?:data|blob|javascript|mailto|tel|about):/i.test(
            trimmed,
          )
        ) {
          return;
        }

        /*
         * Meta refresh requires special handling.
         *
         * Don't attempt to rewrite arbitrary meta content.
         */
        if (
          selector === "meta" &&
          attribute === "content"
        ) {
          return;
        }

        try {
          element.setAttribute(
            attribute,
            proxyResourceUrl(
              trimmed,
              target,
              proxyBase,
            ),
          );
        } catch {
          /*
           * Invalid URL: leave untouched.
           */
        }
      },
    });
  }


  /*
   * ---------------------------------------------------------
   * META REFRESH
   * ---------------------------------------------------------
   */

  rewriter.on("meta[http-equiv]", {
    element(element) {
      const equiv = (
        element.getAttribute("http-equiv") || ""
      ).toLowerCase();

      if (equiv !== "refresh") return;

      const content = element.getAttribute("content");

      if (!content) return;

      /*
       * Typical format:
       *
       * 0; url=https://example.com/
       */
      const match = content.match(
        /^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i,
      );

      if (!match) return;

      try {
        element.setAttribute(
          "content",
          match[1] +
            proxyResourceUrl(
              match[2].trim(),
              target,
              proxyBase,
            ),
        );
      } catch {
        /*
         * Leave unchanged.
         */
      }
    },
  });


  /*
   * ---------------------------------------------------------
   * SRCSET
   * ---------------------------------------------------------
   *
   * Handles:
   *
   * srcset="image.jpg 1x, image@2x.jpg 2x"
   */
  for (const selector of [
    "img",
    "source",
    "video",
    "audio",
  ]) {
    rewriter.on(selector, {
      element(element) {
        const value = element.getAttribute(
          "srcset",
        );

        if (!value) return;

        const rewritten = value
          .split(",")
          .map((entry) => {
            const bits = entry.trim().split(/\s+/);

            if (!bits[0]) {
              return entry;
            }

            try {
              bits[0] = proxyResourceUrl(
                bits[0],
                target,
                proxyBase,
              );
            } catch {
              return entry;
            }

            return bits.join(" ");
          })
          .join(", ");

        element.setAttribute(
          "srcset",
          rewritten,
        );
      },
    });
  }


  /*
   * ---------------------------------------------------------
   * INLINE STYLE
   * ---------------------------------------------------------
   *
   * Handles:
   *
   * style="background:url('/image.png')"
   */
  rewriter.on("[style]", {
    element(element) {
      const value = element.getAttribute(
        "style",
      );

      if (!value || !/url\s*\(/i.test(value)) {
        return;
      }

      const rewritten = value.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (full, quote, resource) => {
          const trimmed = resource.trim();

          if (
            /^(?:data|blob|javascript):/i.test(
              trimmed,
            ) ||
            trimmed.startsWith("#")
          ) {
            return full;
          }

          try {
            return (
              `url(${quote}` +
              proxyResourceUrl(
                trimmed,
                target,
                proxyBase,
              ) +
              `${quote})`
            );
          } catch {
            return full;
          }
        },
      );

      element.setAttribute(
        "style",
        rewritten,
      );
    },
  });


  /*
   * ---------------------------------------------------------
   * STYLE BLOCKS
   * ---------------------------------------------------------
   *
   * Handles CSS such as:
   *
   * background-image:url(...)
   */
  rewriter.on("style", {
    text(text) {
      text.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (full, quote, resource) => {
          const trimmed = resource.trim();

          if (
            /^(?:data|blob|javascript):/i.test(
              trimmed,
            ) ||
            trimmed.startsWith("#")
          ) {
            return full;
          }

          try {
            return (
              `url(${quote}` +
              proxyResourceUrl(
                trimmed,
                target,
                proxyBase,
              ) +
              `${quote})`
            );
          } catch {
            return full;
          }
        },
      );
    },
  });


  /*
   * ---------------------------------------------------------
   * BASE HREF
   * ---------------------------------------------------------
   *
   * A <base> element can otherwise make every relative iframe,
   * script, stylesheet, etc. escape the proxy.
   */
  rewriter.on("base", {
    element(element) {
      const value = element.getAttribute(
        "href",
      );

      if (!value) return;

      try {
        element.setAttribute(
          "href",
          proxyResourceUrl(
            value,
            target,
            proxyBase,
          ),
        );
      } catch {
        /*
         * Leave unchanged.
         */
      }
    },
  });


  /*
   * Transform the upstream response body.
   */
  return rewriter.transform(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}


/*
 * =========================================================
 * UPSTREAM FETCH
 * =========================================================
 */

async function fetchUpstream(
  request,
  target,
) {
  const headers = new Headers(
    request.headers,
  );

  /*
   * The browser's Host belongs to the proxy.
   */
  headers.delete("Host");

  /*
   * Don't tell the upstream site that the request originated
   * from the proxy's own origin.
   *
   * This also avoids many CORS / origin checks that make
   * embedded resources fail.
   */
  headers.delete("Origin");
  headers.delete("Referer");

  /*
   * These can describe the proxy rather than the target.
   */
  headers.delete("Sec-Fetch-Site");
  headers.delete("Sec-Fetch-Mode");
  headers.delete("Sec-Fetch-Dest");

  return fetch(target, {
    method: request.method,

    headers,

    body: ["GET", "HEAD"].includes(
      request.method,
    )
      ? undefined
      : request.body,

    /*
     * Follow redirects so the HTML/resource gets resolved by
     * the proxy instead of sending the browser directly to the
     * original host.
     */
    redirect: "follow",
  });
}


/*
 * =========================================================
 * PROXY REQUEST
 * =========================================================
 */

async function proxyRequest(
  request,
  target,
  proxyBase,
) {
  const upstream = await fetchUpstream(
    request,
    target,
  );

  /*
   * HTML gets the full URL rewriter.
   */
  if (
    request.method !== "HEAD" &&
    isHtmlResponse(
      upstream,
      target,
    )
  ) {
    return rewriteHtml(
      upstream,
      target,
      proxyBase,
    );
  }


  /*
   * Non-HTML responses still get the configurable header
   * policy and cookie/redirect handling.
   */
  const headers = cleanResponseHeaders(
    upstream.headers,
  );

  rewriteSetCookies(headers);

  rewriteLocationHeader(
    headers,
    target,
    proxyBase,
  );

  return new Response(
    upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    },
  );
}


/*
 * =========================================================
 * TARGET VALIDATION
 * =========================================================
 */

function isValidDomain(value) {
  return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
    value,
  );
}

function isValidGithubUser(value) {
  return /^[A-Za-z0-9-]+$/.test(
    value,
  );
}


/*
 * =========================================================
 * MAIN CLOUDFLARE PAGES FUNCTION
 * =========================================================
 */

export async function onRequest({
  request,
}) {
  const url = new URL(
    request.url,
  );

  const parts = url.pathname
    .split("/")
    .filter(Boolean);


  /*
   * =======================================================
   * /$/TARGET ROUTING
   * =======================================================
   */

  if (parts[0] === "$") {
    const targetName = parts[1];

    if (!targetName) {
      return new Response(
        "Missing user or domain",
        {
          status: 400,
        },
      );
    }

    const remainingParts =
      parts.slice(2);

    const targetPath =
      remainingParts.length > 0
        ? "/" +
          remainingParts.join("/")
        : "/";


    /*
     * -------------------------------------------------------
     * Explicit domain
     * -------------------------------------------------------
     */

    if (targetName.includes(".")) {
      if (!isValidDomain(targetName)) {
        return new Response(
          "Invalid domain",
          {
            status: 400,
          },
        );
      }

      const target = new URL(
        `https://${targetName}`,
      );

      target.pathname =
        targetPath;

      target.search =
        url.search;

      const response =
        await proxyRequest(
          request,
          target,
          url,
        );

      const headers =
        new Headers(
          response.headers,
        );

      headers.append(
        "Set-Cookie",
        `proxy_domain=${encodeURIComponent(
          targetName,
        )}; Path=/; Secure; SameSite=Lax`,
      );

      return new Response(
        response.body,
        {
          status: response.status,
          statusText:
            response.statusText,
          headers,
        },
      );
    }


    /*
     * -------------------------------------------------------
     * GitHub user
     * -------------------------------------------------------
     */

    if (
      !isValidGithubUser(
        targetName,
      )
    ) {
      return new Response(
        "Invalid GitHub username",
        {
          status: 400,
        },
      );
    }

    const target = new URL(
      `https://${targetName}.github.io`,
    );

    target.pathname =
      targetPath;

    target.search =
      url.search;

    const response =
      await proxyRequest(
        request,
        target,
        url,
      );

    const headers =
      new Headers(
        response.headers,
      );

    headers.append(
      "Set-Cookie",
      `github_user=${encodeURIComponent(
        targetName,
      )}; Path=/; Secure; SameSite=Lax`,
    );

    /*
     * Clear a previously selected explicit domain.
     */
    headers.append(
      "Set-Cookie",
      "proxy_domain=; Path=/; Max-Age=0; Secure; SameSite=Lax",
    );

    return new Response(
      response.body,
      {
        status: response.status,
        statusText:
          response.statusText,
        headers,
      },
    );
  }


  /*
   * =======================================================
   * NORMAL REQUEST
   * =======================================================
   *
   * Example:
   *
   * /index.html
   * /style.css
   * /game.js
   * /iframe.html
   *
   * The selected target is restored from cookies.
   */

  const cookies =
    request.headers.get(
      "Cookie",
    ) || "";


  const user =
    cookies.match(
      /(?:^|;\s*)github_user=([^;]+)/,
    )?.[1];


  const domain =
    cookies.match(
      /(?:^|;\s*)proxy_domain=([^;]+)/,
    )?.[1];


  /*
   * -------------------------------------------------------
   * Saved domain
   * -------------------------------------------------------
   */

  if (domain) {
    let decodedDomain;

    try {
      decodedDomain =
        decodeURIComponent(
          domain,
        );
    } catch {
      return new Response(
        "Invalid saved domain",
        {
          status: 400,
        },
      );
    }

    if (
      !isValidDomain(
        decodedDomain,
      )
    ) {
      return new Response(
        "Invalid saved domain",
        {
          status: 400,
        },
      );
    }

    const target = new URL(
      `https://${decodedDomain}`,
    );

    target.pathname =
      url.pathname || "/";

    target.search =
      url.search;

    return proxyRequest(
      request,
      target,
      url,
    );
  }


  /*
   * -------------------------------------------------------
   * Saved GitHub user
   * -------------------------------------------------------
   */

  if (user) {
    let decodedUser;

    try {
      decodedUser =
        decodeURIComponent(
          user,
        );
    } catch {
      return new Response(
        "Invalid saved GitHub username",
        {
          status: 400,
        },
      );
    }

    if (
      !isValidGithubUser(
        decodedUser,
      )
    ) {
      return new Response(
        "Invalid saved GitHub username",
        {
          status: 400,
        },
      );
    }

    const target = new URL(
      `https://${decodedUser}.github.io`,
    );

    target.pathname =
      url.pathname || "/";

    target.search =
      url.search;

    return proxyRequest(
      request,
      target,
      url,
    );
  }


  /*
   * =======================================================
   * NOTHING SELECTED
   * =======================================================
   */

  return new Response(
    "No user or domain selected",
    {
      status: 400,
    },
  );
}
