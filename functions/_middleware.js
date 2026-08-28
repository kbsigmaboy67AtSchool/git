export async function onRequest(context) {
  const url = new URL(context.request.url);

  // https://GITHUBUSER@mysite.pages.dev/path?query
  const user = url.username;

  if (!user) {
    return new Response("Use https://GITHUBUSER@mysite.pages.dev/...", {
      status: 400,
    });
  }

  // Basic username validation
  if (!/^[A-Za-z0-9-]+$/.test(user)) {
    return new Response("Invalid GitHub username", { status: 400 });
  }

  const target = new URL(`https://${user}.github.io`);
  target.pathname = url.pathname;
  target.search = url.search;

  return Response.redirect(target.toString(), 302);
}
