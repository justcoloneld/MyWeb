import { handleProxy } from "../server/proxy.js";

export default async function proxyHandler(request, response) {
  const requestUrl = new URL(request.url ?? "/api/proxy", "http://localhost");
  await handleProxy(request, response, requestUrl.searchParams.get("url"));
}
