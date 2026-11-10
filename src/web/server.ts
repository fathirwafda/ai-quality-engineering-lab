/** Tiny demo UI for the copilot: `npm run serve`, then open http://localhost:3000. Uses LLM_PROVIDER (mock by default). */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SupportCopilot } from "../copilot";
import { createProvider } from "../providers";

const PAGE = join(process.cwd(), "src", "web", "public", "index.html");
const MAX_BODY_BYTES = 8 * 1024;

export function createApp(copilot = new SupportCopilot({ provider: createProvider() })): Server {
  return createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(PAGE));
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          res.writeHead(413).end();
          return;
        }
      }
      let message: unknown;
      try {
        message = (JSON.parse(body) as { message?: unknown }).message;
      } catch {
        message = undefined;
      }
      if (typeof message !== "string" || !message.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "message must be a non-empty string" }));
        return;
      }
      const { output, trace } = await copilot.answer(message.slice(0, 2000));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          output,
          trace: { retrieved: trace.retrieved, latencyMs: trace.latencyMs, model: trace.model },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`Support Copilot demo on http://localhost:${port}`));
}
