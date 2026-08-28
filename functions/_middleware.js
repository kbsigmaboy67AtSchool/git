export async function onRequest(context) {
  /*
   * Middleware intentionally does not interpret normal paths.
   *
   * Examples:
   *
   * /themes.css
   * /index.html
   * /foo/bar
   * /api/test
   *
   * All of these are normal requests and continue to [[path]].js.
   *
   * The "$" prefix is reserved for special routing:
   *
   * /$/...
   */

  return context.next();
}
