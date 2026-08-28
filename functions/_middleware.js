export async function onRequest({ request }) {
  const url = new URL(request.url);

  const data = {
    request_url: request.url,
    url_username: url.username,
    url_password: url.password,
    url_host: url.host,
    url_path: url.pathname,
    url_search: url.search,
    headers: Object.fromEntries(request.headers),
  };

  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json" },
  });
}a
