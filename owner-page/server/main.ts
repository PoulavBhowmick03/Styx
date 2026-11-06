// Local backend for the World gate. It runs only when the gate is enabled, and holds the World
// client secret so the browser never sees it. Vite proxies /api to it during development.
//
// Needs WORLD_CLIENT_ID, WORLD_CLIENT_SECRET and WORLD_REDIRECT_URI. WORLD_OWNER_SUBJECT holds the
// enrolled owner. WORLD_ACCEPTED_ACR is an optional comma-separated list.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StepUp, StepUpError } from "./stepup";

const PORT = Number(process.env.WORLD_GATE_PORT ?? 8787);
const MAX_BODY_BYTES = 4096;
const DISCOVERY_URL = "https://auth.world.org/.well-known/openid-configuration";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const stepUp = new StepUp(
  {
    discoveryUrl: process.env.WORLD_DISCOVERY_URL ?? DISCOVERY_URL,
    clientId: required("WORLD_CLIENT_ID"),
    clientSecret: required("WORLD_CLIENT_SECRET"),
    redirectUri: required("WORLD_REDIRECT_URI"),
    ...(process.env.WORLD_OWNER_SUBJECT ? { ownerSubject: process.env.WORLD_OWNER_SUBJECT } : {}),
    acceptedAcr: (process.env.WORLD_ACCEPTED_ACR ?? "").split(",").filter(Boolean),
  },
  { fetch, nowSeconds: () => Math.floor(Date.now() / 1000) },
);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > MAX_BODY_BYTES) throw new StepUpError("the request is too large");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function closingPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>World check</title><p>${safe}</p><p>You can close this window.</p>`;
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    json(response, 400, { error: error instanceof StepUpError ? error.message : "the request failed" });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/api/step-up/start") {
    const body = await readBody(request);
    json(response, 200, await stepUp.start(String(body.digest)));
  } else if (request.method === "GET" && url.pathname === "/api/step-up/callback") {
    const outcome = await stepUp.callback(url.searchParams);
    const message =
      outcome.status === "approved"
        ? "Verified. Return to the approval page."
        : `Not verified: ${outcome.status === "denied" ? outcome.reason : "still pending"}`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(closingPage(message));
  } else if (request.method === "GET" && url.pathname === "/api/step-up/status") {
    json(response, 200, stepUp.status(url.searchParams.get("attemptId") ?? ""));
  } else if (request.method === "POST" && url.pathname === "/api/step-up/consume") {
    const body = await readBody(request);
    json(response, 200, { allowed: stepUp.consume(String(body.attemptId), String(body.digest)) });
  } else {
    json(response, 404, { error: "not found" });
  }
}

// Loopback only: a tunnel or proxy the owner runs provides the HTTPS callback World requires.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`World gate listening on http://127.0.0.1:${PORT}`);
});
