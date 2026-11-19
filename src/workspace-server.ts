import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { workspaceStore } from "./workspace-store.ts";
import { parseWorkspaceArgs } from "./workspace-options.ts";
import { defaultProject, resolveProjects, workspaceIdentity } from "./workspace-projects.ts";

const { live, projectPath, projects: specifiedProjects, provider } = parseWorkspaceArgs(process.argv.slice(2));
let projects = live
  ? resolveProjects(specifiedProjects.length ? specifiedProjects : [defaultProject(projectPath ?? ".")])
  : [defaultProject(process.cwd())];
if (live && !specifiedProjects.length) projects = [defaultProject(projects[0].path)];
const cwd = projects[0].path;
const identity = workspaceIdentity(projects);
const port = Number(process.env.ORCHESTRA_PORT ?? process.env.SWARMER_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ORCHESTRA_PORT");
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
let runtime: WorkspaceRuntime;

async function readCommand(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Message exceeds the workspace limit");
    chunks.push(chunk);
  }
  const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof command?.agentId !== "string") throw new Error("Invalid agent");
  if (command.type === "resumeQueue") return { type: "resumeQueue" as const, agentId: command.agentId };
  if ((command.type === "send" || command.type === "steer") && typeof command.text === "string" && command.text.trim()) {
    return { type: command.type as "send" | "steer", agentId: command.agentId, text: command.text };
  }
  if (command.type === "approval" && typeof command.approvalId === "string" &&
    (command.decision === "accept" || command.decision === "decline")) {
    return { type: "approval" as const, agentId: command.agentId, approvalId: command.approvalId, decision: command.decision as "accept" | "decline" };
  }
  throw new Error("Invalid workspace command");
}

const server = createServer(async (request, response) => {
  if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)) {
    response.writeHead(403).end();
    return;
  }
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const path = request.url?.split("?")[0];
  if (request.method === "GET" && path === "/api/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const publish = (snapshot: ReturnType<typeof runtime.snapshot>) => response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    const unsubscribe = runtime.subscribe(publish);
    const unsubscribeSignals = runtime.subscribeSignals((signal) => response.write(`event: agent-signal\ndata: ${JSON.stringify(signal)}\n\n`));
    publish(runtime.snapshot());
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    response.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeSignals();
    });
    return;
  }
  if (request.method === "POST" && path === "/api/command") {
    if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
      response.writeHead(403).end();
      return;
    }
    try {
      await runtime.command(await readCommand(request));
      response.writeHead(204).end();
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : "Workspace command failed" }));
    }
    return;
  }
  if (request.method === "GET" && (path === "/" || /^\/assets\/[\w.-]+\.(js|css|svg)$/.test(path ?? ""))) {
    const filename = path === "/" ? "index.html" : path!.slice(1);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(filename)] ?? "application/octet-stream";
    try {
      const body = await readFile(resolve(dist, filename));
      response.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  runtime = new WorkspaceRuntime({
    cwd,
    projects,
    demo: !live,
    provider,
    store: live ? workspaceStore(identity, undefined, provider) : undefined,
  });
  console.log(`Orchestra ${live ? `(Codex: ${provider})` : "(demo)"} is available at ${origin}`);
  void runtime.start().catch((error) => console.error("Workspace startup failed:", error instanceof Error ? error.message : error));
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
    void runtime?.close().catch((error) => console.error("Workspace shutdown failed:", error));
  });
}
