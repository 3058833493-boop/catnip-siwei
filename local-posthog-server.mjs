import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMetricsSource, buildTemplateMetricsSource } from "./functions/_lib/posthog-live-metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const port = Number(process.env.PORT || 8790);

for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(root, envFile);
  if (!fs.existsSync(envPath)) continue;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function serveFile(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, "Forbidden");
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/template-metrics") {
    try {
      const data = await buildTemplateMetricsSource(process.env);
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendJson(res, error && error.status ? error.status : 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/metrics") {
    try {
      const data = await buildMetricsSource(process.env, {
        start: url.searchParams.get("start"),
        end: url.searchParams.get("end"),
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendJson(res, error && error.status ? error.status : 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
    return;
  }
  serveFile(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Template Metrics live preview: http://127.0.0.1:${port}/`);
  console.log("Set POSTHOG_PERSONAL_API_KEY to enable /api/metrics.");
});
