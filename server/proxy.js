import dns from "node:dns";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ipaddr from "ipaddr.js";
import * as cheerio from "cheerio";
import { Agent, fetch } from "undici";

const MAX_URL_LENGTH = 4_096;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 32;
const UPSTREAM_TIMEOUT_MS = 25_000;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home", ".test", ".example", ".invalid", ".onion"];
const OMIT_REQUEST_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "accept-encoding", "cookie",
  "origin", "referer", "proxy-authorization", "proxy-connection", "forwarded", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
  "sec-fetch-user", "upgrade", "te", "trailer",
]);
const OMIT_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "content-encoding", "alt-svc", "clear-site-data",
  "content-security-policy", "content-security-policy-report-only", "report-to", "nel", "link",
]);
let activeRequests = 0;

export class ProxyError extends Error {
  constructor(status, message, code = "EPROXY") {
    super(message);
    this.name = "ProxyError";
    this.status = status;
    this.code = code;
  }
}

function normalizedHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isPublicAddress(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function assertAllowedHost(hostname) {
  const host = normalizedHostname(hostname);
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new ProxyError(403, "Private and local network destinations are blocked.", "EPRIVATEIP");
  }

  if (!isIP(host) && !host.includes(".")) {
    throw new ProxyError(403, "Single-name local network destinations are blocked.", "EPRIVATEIP");
  }

  if (isIP(host) && !isPublicAddress(host)) {
    throw new ProxyError(403, "Private and local network destinations are blocked.", "EPRIVATEIP");
  }
}

export function parseDestination(input, baseUrl) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw new ProxyError(400, "Enter a web address shorter than 4,096 characters.", "EURL");
  }

  let destination;
  try {
    destination = baseUrl ? new URL(input, baseUrl) : new URL(input);
  } catch {
    throw new ProxyError(400, "That web address is not valid. Check it and try again.", "EURL");
  }

  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new ProxyError(400, "Only HTTP and HTTPS websites can be opened.", "EPROTOCOL");
  }
  if (destination.username || destination.password) {
    throw new ProxyError(400, "Web addresses containing embedded usernames or passwords are not supported.", "ECREDENTIALS");
  }

  assertAllowedHost(destination.hostname);
  return destination;
}

function createSafeAgent() {
  const safeLookup = (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      if (!addresses?.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
        const blocked = new Error("Private and local network destinations are blocked.");
        blocked.code = "EPRIVATEIP";
        callback(blocked);
        return;
      }
      if (typeof options === "object" && options?.all) {
        callback(null, addresses);
      } else {
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      }
    });
  };

  return new Agent({ connect: { lookup: safeLookup } });
}

function cookiePrefix(hostname) {
  return `mw_${Buffer.from(normalizedHostname(hostname)).toString("base64url")}_`;
}

function cookiesForDestination(cookieHeader, hostname) {
  if (!cookieHeader) return "";
  const prefix = cookiePrefix(hostname);
  return cookieHeader.split(";").map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator);
    if (!name.startsWith(prefix)) return [];
    return [`${name.slice(prefix.length)}${part.slice(separator)}`];
  }).join("; ");
}

function cookieFromDestination(rawCookie, hostname) {
  const parts = rawCookie.split(";");
  const separator = parts[0].indexOf("=");
  if (separator < 1) return null;
  const originalName = parts[0].slice(0, separator).trim();
  const value = parts[0].slice(separator + 1);
  const attributes = parts.slice(1).map((part) => part.trim()).filter((part) => {
    const name = part.split("=", 1)[0].trim().toLowerCase();
    return name !== "domain" && name !== "path";
  });
  return `${cookiePrefix(hostname)}${originalName}=${value}; Path=/${attributes.length ? `; ${attributes.join("; ")}` : ""}`;
}

function destinationReferer(request) {
  const referer = request.headers.referer;
  if (!referer) return "";
  try {
    const parsed = new URL(referer);
    const priorTarget = parsed.searchParams.get("url");
    if ((parsed.pathname === "/proxy" || parsed.pathname === "/api/proxy") && priorTarget) {
      const prior = parseDestination(priorTarget);
      return prior.href;
    }
  } catch {
    return "";
  }
  return "";
}

function requestHeaders(request, destination) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();
    if (OMIT_REQUEST_HEADERS.has(lowerName) || value === undefined) continue;
    headers[lowerName] = value;
  }

  const cookieHeader = cookiesForDestination(request.headers.cookie, destination.hostname);
  if (cookieHeader) headers.cookie = cookieHeader;

  const referer = destinationReferer(request);
  if (referer) headers.referer = referer;
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(request.method ?? "GET")) {
    headers.origin = destination.origin;
  }
  return headers;
}

async function readRequestBody(request) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ProxyError(413, "This request is larger than the 2 MB limit.", "E_BODY_LIMIT");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new ProxyError(413, "This request is larger than the 2 MB limit.", "E_BODY_LIMIT");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function proxyUrl(destination) {
  return `/api/proxy?url=${encodeURIComponent(destination.href)}`;
}

function rewriteUrl(value, baseUrl) {
  const raw = value.trim();
  if (!raw || raw.startsWith("#") || /^(?:data|blob|javascript|mailto|tel|about|file):/i.test(raw)) return value;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return value;
    resolved.hash = resolved.hash;
    return proxyUrl(resolved);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, baseUrl) {
  if (/^\s*data:/i.test(value) || /,\s*data:/i.test(value)) return value;
  return value.replace(/(^|,)\s*([^\s,]+)(\s+[^,]+)?/g, (match, delimiter, source, descriptor = "") => {
    return `${delimiter}${rewriteUrl(source, baseUrl)}${descriptor}`;
  });
}

function rewriteCss(css, baseUrl) {
  let output = css.replace(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi, (match, quote, quoted, unquoted) => {
    const value = (quoted ?? unquoted ?? "").trim();
    if (!value) return match;
    const rewritten = rewriteUrl(value, baseUrl);
    return `url(${quote ?? ""}${rewritten}${quote ?? ""})`;
  });

  output = output.replace(/(@import\s+)(['"])([^'"]+)\2/gi, (match, prefix, quote, value) => {
    return `${prefix}${quote}${rewriteUrl(value, baseUrl)}${quote}`;
  });
  return output;
}

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $("base").remove();
  $('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="Content-Security-Policy-Report-Only"]').remove();

  const urlAttributes = ["href", "src", "action", "formaction", "poster", "data", "cite", "xlink:href"];
  for (const attribute of urlAttributes) {
    const selector = `[${attribute.replace(/:/g, "\\:")}]`;
    $(selector).each((_index, element) => {
      const value = $(element).attr(attribute);
      if (value !== undefined) $(element).attr(attribute, rewriteUrl(value, baseUrl));
    });
  }

  $("[srcset]").each((_index, element) => {
    const value = $(element).attr("srcset");
    if (value !== undefined) $(element).attr("srcset", rewriteSrcset(value, baseUrl));
  });

  $("[style]").each((_index, element) => {
    const value = $(element).attr("style");
    if (value !== undefined) $(element).attr("style", rewriteCss(value, baseUrl));
  });
  $("style").each((_index, element) => {
    const value = $(element).html();
    if (value) $(element).html(rewriteCss(value, baseUrl));
  });

  $('meta[http-equiv="refresh"]').each((_index, element) => {
    const value = $(element).attr("content");
    if (!value) return;
    const match = value.match(/^(\s*\d+\s*;\s*url\s*=\s*)(['"]?)(.*?)\2\s*$/i);
    if (match) $(element).attr("content", `${match[1]}${match[2]}${rewriteUrl(match[3], baseUrl)}${match[2]}`);
  });

  $("head").append('<script src="/proxy-toolbar.js" defer></script>');
  return $.html();
}

function responseHeaders(upstream, destination) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    const lowerName = name.toLowerCase();
    if (OMIT_RESPONSE_HEADERS.has(lowerName) || lowerName === "set-cookie" || lowerName.startsWith("content-security-policy")) continue;
    if (lowerName === "location") {
      headers.location = rewriteUrl(value, destination);
    } else if (lowerName === "refresh") {
      const match = value.match(/^(\s*\d+\s*;\s*url\s*=\s*)(['"]?)(.*?)\2\s*$/i);
      headers.refresh = match ? `${match[1]}${match[2]}${rewriteUrl(match[3], destination)}${match[2]}` : value;
    } else {
      headers[lowerName] = value;
    }
  }

  const cookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  const rewrittenCookies = cookies.map((cookie) => cookieFromDestination(cookie, destination.hostname)).filter(Boolean);
  if (rewrittenCookies.length) headers["set-cookie"] = rewrittenCookies;
  headers["x-content-type-options"] = "nosniff";
  headers["referrer-policy"] = "no-referrer";
  return headers;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function sendError(response, status, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const safeMessage = escapeHtml(message);
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy request could not be completed</title><style>body{margin:0;background:#0b1116;color:#eff5f2;font:16px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:560px;padding:36px;border:1px solid #26343a;border-radius:20px;background:#111a20}h1{font-size:24px;margin:0 0 12px}p{color:#aebbb7}a{color:#a9e36d}</style><main class="card"><h1>We couldn’t open that address</h1><p>${safeMessage}</p><a href="/">Return to MyWeb Proxy</a></main></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function errorCode(error) {
  return error?.code ?? error?.cause?.code ?? error?.cause?.cause?.code ?? "";
}

function messageForError(error) {
  if (error instanceof ProxyError) return error.message;
  if (errorCode(error) === "EPRIVATEIP" || String(error?.message).includes("Private and local")) {
    return "This destination resolves to a private or local network address. MyWeb Proxy blocks those destinations for safety.";
  }
  if (error?.name === "AbortError" || errorCode(error) === "UND_ERR_CONNECT_TIMEOUT") {
    return "The destination took too long to respond. Try again in a moment.";
  }
  if (errorCode(error) === "ENOTFOUND" || errorCode(error) === "EAI_AGAIN") {
    return "The destination host could not be found. Check the address and try again.";
  }
  return "The destination could not be reached, or it returned a response this proxy cannot process.";
}

async function readLimitedBody(body, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) throw new ProxyError(502, "This page is too large to rewrite safely.", "E_RESPONSE_LIMIT");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseLimiter() {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        callback(new ProxyError(502, "This response is larger than the 32 MB limit.", "E_RESPONSE_LIMIT"));
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function handleProxy(request, response, rawDestination) {
  if (!rawDestination) {
    sendError(response, 400, "Enter a website address in the box on the home page.");
    return;
  }
  if (!ALLOWED_METHODS.has(request.method ?? "GET")) {
    sendError(response, 405, "That request method is not supported.");
    return;
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    sendError(response, 503, "The proxy is busy handling its request limit. Try again shortly.");
    return;
  }

  let destination;
  try {
    destination = parseDestination(rawDestination);
  } catch (error) {
    sendError(response, error.status ?? 400, messageForError(error));
    return;
  }

  activeRequests += 1;
  const dispatcher = createSafeAgent();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const requestBody = ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : await readRequestBody(request);
    const upstream = await fetch(destination, {
      method: request.method,
      headers: requestHeaders(request, destination),
      body: requestBody?.length ? requestBody : undefined,
      redirect: "manual",
      dispatcher,
      signal: controller.signal,
    });

    const headers = responseHeaders(upstream, destination);
    const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    const isCss = contentType.includes("text/css");

    if (upstream.body && (isHtml || isCss)) {
      const text = await readLimitedBody(upstream.body, MAX_REWRITE_BYTES);
      const rewritten = isHtml ? rewriteHtml(text, destination) : rewriteCss(text, destination);
      response.writeHead(upstream.status, headers);
      response.end(rewritten);
      return;
    }

    const declaredResponseLength = Number(upstream.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredResponseLength) && declaredResponseLength > MAX_RESPONSE_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      sendError(response, 502, "This response is larger than the 32 MB limit.");
      return;
    }

    response.writeHead(upstream.status, headers);
    if (!upstream.body || request.method === "HEAD") {
      response.end();
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), responseLimiter(), response);
    console.log(`Proxy ${request.method} ${destination.hostname} ${upstream.status}`);
  } catch (error) {
    console.error(`Proxy error ${request.method} ${destination.hostname} ${errorCode(error) || error.name}`);
    const status = error instanceof ProxyError ? error.status : (error?.name === "AbortError" ? 504 : 502);
    sendError(response, status, messageForError(error));
  } finally {
    clearTimeout(timeout);
    activeRequests -= 1;
    await dispatcher.close().catch(() => {});
  }
}
