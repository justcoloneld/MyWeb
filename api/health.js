export default function healthHandler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, service: "myweb-proxy" }));
}
