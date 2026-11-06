// The relay's HTTP surface. See ../README.md.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Relay, RelayError, tokenMatches, type RelayConfig } from "./relay";

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > MAX_BODY_BYTES) throw new RelayError(413, "the request is too large");
    chunks.push(piece);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayError(400, "the body is not valid JSON");
  }
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function relayServer(relay: Relay, config: RelayConfig): Server {
  const pageOrigin = new URL(config.pageUrl).origin;

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": pageOrigin,
        vary: "origin",
      });
      response.end(JSON.stringify(body));
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": pageOrigin,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        vary: "origin",
      });
      response.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && url.pathname === "/requests") {
      // Checked inside: a v2 token belongs to one agent, which only the request can name.
      const body = (await readJson(request)) as { pending?: unknown };
      reply(200, await relay.submit(body?.pending, bearer(request)));
    } else if (request.method === "POST" && url.pathname === "/alerts") {
      if (!tokenMatches(bearer(request), config.watcherToken)) throw new RelayError(401, "unauthorized");
      reply(200, await relay.notice(await readJson(request)));
    } else if (parts[0] === "requests" && parts.length === 2 && request.method === "GET") {
      // The ID is a random capability that only the owner's alert and the agent hold.
      reply(200, { pending: relay.pending(parts[1]!) });
    } else if (parts[0] === "requests" && parts[2] === "signature" && parts.length === 3 && request.method === "POST") {
      await relay.sign(parts[1]!, await readJson(request));
      reply(200, { accepted: true });
    } else if (parts[0] === "requests" && parts[2] === "signature" && parts.length === 3 && request.method === "GET") {
      reply(200, relay.signature(parts[1]!, bearer(request)));
    } else {
      throw new RelayError(404, "not found");
    }
  };

  return createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const status = error instanceof RelayError ? error.status : 500;
      const message = error instanceof RelayError ? error.message : "the request failed";
      if (!response.headersSent) {
        response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": pageOrigin, vary: "origin" });
      }
      response.end(JSON.stringify({ error: message }));
    });
  });
}
