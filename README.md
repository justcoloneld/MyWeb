# MyWeb Proxy

A self-hostable web proxy for public HTTP and HTTPS destinations. The app forwards requests from its Node server, rewrites common HTML and CSS resource URLs, scopes upstream cookies to the destination host, and adds a compact navigation bar to proxied HTML pages.

## Run locally

Requirements: Node.js 20.18.1 or newer and npm 10.9.2.

```sh
cp .env.example .env
npm ci
npm start
```

Open `http://localhost:3000`. Set `PORT` to change the listen port.

## Safety limits

Only HTTP and HTTPS are accepted. The proxy blocks literal private, loopback, link-local, reserved, and local-network targets. DNS results are checked at connection time and any private result is rejected. Requests are limited to 2 MB, rewritten HTML/CSS to 8 MB, streamed responses to 32 MB, upstream waits to 25 seconds, and simultaneous proxied requests to 32.

This is a public-destination fetch proxy, not an anonymity service. The server operator can see destination hosts and request data. Do not enter sensitive credentials unless you control the deployment and understand its logging and hosting environment. Proxied pages execute in the proxy's browser origin; use a dedicated deployment and avoid signing into sensitive accounts. No user authentication is included, so add an access-control layer before exposing a shared instance to the public internet.

Some websites may not work fully. JavaScript-generated absolute requests, WebSockets, streaming APIs, anti-bot challenges, and sites that require browser-specific behavior are not fully rewritten or supported. The proxy forwards common HTTP methods and rewrites ordinary links, forms, scripts, stylesheets, images, source sets, CSS URLs, refreshes, and redirects.

## Container

Build and run with Docker:

```sh
docker build -t myweb-proxy .
docker run --rm -p 3000:3000 -e PORT=3000 myweb-proxy
```

The server listens on `0.0.0.0` and exposes `/api/health` for readiness checks.

## Vercel

The `public/` directory contains the frontend. Vercel serves `api/proxy.js` at `/api/proxy` and `api/health.js` at `/api/health`; the proxy UI and rewritten page resources use the same `/api/proxy` route. Ensure the Vercel project is connected to this repository and deploys the `main` branch.
