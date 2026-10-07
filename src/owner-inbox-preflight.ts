import type { ServerResponse } from "node:http";

export function writeOwnerInboxPreflight(response: ServerResponse, origin: string): void {
  response.writeHead(204, {
    Allow: "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-jarvis-csrf",
    "Access-Control-Max-Age": "600",
  });
  response.end();
}
