import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { handleProxy } from "./server/proxy.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(root, "public");
const contentTypes = {
  "/": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/proxy-toolbar.js": "text/javascript; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
  "/manus-routes.json": "application/json; charset=utf-8",
};

async function sendFile(response, route, method = "GET") {
  const fileName = route === "/" ? "index.html" : route.slice(1);
  const filePath = path.join(publicDirectory, fileName);
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[route] ?? "application/octet-stream",
      "cache-control": route === "/" ? "no-store" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Application asset unavailable.");
  }
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (requestUrl.pathname === "/api/health" && (method === "GET" || method === "HEAD")) {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : JSON.stringify({ ok: true, service: "myweb-proxy" }));
    return;
  }

  if (requestUrl.pathname === "/proxy") {
    await handleProxy(request, response, requestUrl.searchParams.get("url"));
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed.");
    return;
  }

  if (Object.hasOwn(contentTypes, requestUrl.pathname)) {
    await sendFile(response, requestUrl.pathname, method);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end("Not found.");
});

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PORT must be an integer between 1024 and 65535.");
}

server.listen(port, "0.0.0.0", () => {
  console.log(`MyWeb Proxy listening on 0.0.0.0:${port}`);
});
