export async function onRequest({ request }) {
  const url = new URL(request.url);

  return new Response(JSON.stringify({
    request_url: request.url,
    username: url.username,
    password: url.password,
    host: url.host,
    pathname: url.pathname,
    search: url.search,
    headers: Object.fromEntries(request.headers),
  }, null, 2), {
    headers: {
      "content-type": "application/json",
    },
  });
}
