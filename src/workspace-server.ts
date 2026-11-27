import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { safeError } from "./app-server.ts";
import { diffScheduler, taskDiff } from "./workspace-diff.ts";
import { workspaceStore } from "./workspace-store.ts";
import { messageCharacterLimit } from "./workspace-chat-recovery.ts";
import { modelChoice } from "./workspace-models.ts";
import { parseWorkspaceArgs } from "./workspace-options.ts";
import { loadLocalImage } from "./workspace-images.ts";
import { defaultProject, resolveProjects, workspaceIdentity } from "./workspace-projects.ts";

const { live, projectPath, projects: specifiedProjects, provider: modelProvider, engine } = parseWorkspaceArgs(process.argv.slice(2));
let projects = live
  ? resolveProjects(specifiedProjects.length ? specifiedProjects : [defaultProject(projectPath ?? ".")])
  : [defaultProject(process.cwd())];
if (live && !specifiedProjects.length) projects = [defaultProject(projects[0].path)];
const cwd = projects[0].path;
const identity = workspaceIdentity(projects);
// Each engine starts from its own default port and moves up when that one is taken, so Codex and Claude can run side by side.
const fixedPort = process.env.ORCHESTRA_PORT !== undefined;
const preferredPort = Number(process.env.ORCHESTRA_PORT ?? (live && engine === "claude" ? 4327 : 4317));
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) throw new Error("Invalid ORCHESTRA_PORT");
let port = preferredPort;
let host = `127.0.0.1:${port}`;
let origin = `http://${host}`;
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
let runtime: WorkspaceRuntime;
// Concurrent requests for the same task's changes share one Git computation.
const sharedDiff = diffScheduler((key) => taskDiff(JSON.parse(key)));

// Fits the longest message Codex accepts even when every character is JSON-escaped.
const commandByteLimit = messageCharacterLimit * 6 + 64 * 1024;

class CommandTooLarge extends Error {}

async function readCommand(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      // Keep reading a slightly oversized body so the client receives the error instead of a reset connection.
      if (size <= commandByteLimit) chunks.push(chunk);
      else if (size > commandByteLimit * 2) {
        // Stop reading without destroying the socket, so the 413 response can still be written.
        request.off("data", onData);
        request.pause();
        resolve();
      }
    };
    request.on("data", onData);
    request.once("end", () => resolve());
    request.once("error", reject);
  });
  if (size > commandByteLimit) {
    throw new CommandTooLarge(`Message is too long (more than ${messageCharacterLimit.toLocaleString("en-US")} characters).`);
  }
  const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (command?.type === "createTask" && typeof command.name === "string" &&
      Array.isArray(command.projectIds) && command.projectIds.every((id: unknown) => typeof id === "string")) {
    return { type: "createTask" as const, name: command.name, projectIds: command.projectIds as string[],
      model: modelChoice(command.model, "model"), effort: modelChoice(command.effort, "reasoning effort") };
  }
  if (typeof command?.agentId !== "string") throw new Error("Invalid agent");
  if (command.type === "setModel") {
    return { type: "setModel" as const, agentId: command.agentId,
      model: modelChoice(command.model, "model"), effort: modelChoice(command.effort, "reasoning effort") };
  }
  if (command.type === "rename" && typeof command.name === "string") {
    return { type: "rename" as const, agentId: command.agentId, name: command.name };
  }
  if (command.type === "archive") {
    if (command.stopRunning !== undefined && typeof command.stopRunning !== "boolean") throw new Error("Invalid stop option");
    return { type: "archive" as const, agentId: command.agentId, stopRunning: command.stopRunning };
  }
  if (command.type === "restore" || command.type === "delete") return { type: command.type as "restore" | "delete", agentId: command.agentId };
  if (command.type === "resumeQueue" || command.type === "cancel") {
    return { type: command.type as "resumeQueue" | "cancel", agentId: command.agentId };
  }
  if ((command.type === "send" || command.type === "steer") && typeof command.text === "string" && command.text.trim()) {
    return { type: command.type as "send" | "steer", agentId: command.agentId, text: command.text };
  }
  if (command.type === "answerProductQuestion" && typeof command.questionId === "string" && command.questionId &&
      typeof command.text === "string" && command.text.trim()) {
    return { type: "answerProductQuestion" as const, agentId: command.agentId, questionId: command.questionId, text: command.text };
  }
  if (command.type === "resolveCommandApproval" && typeof command.requestId === "string" && command.requestId &&
      (command.decision === "approve" || command.decision === "approveForSession" || command.decision === "decline")) {
    return { type: "resolveCommandApproval" as const, agentId: command.agentId, requestId: command.requestId,
      decision: command.decision as "approve" | "approveForSession" | "decline" };
  }
  if (command.type === "approveImplementation" && typeof command.requestId === "string" && command.requestId) {
    return { type: "approveImplementation" as const, agentId: command.agentId, requestId: command.requestId };
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
  if (request.method === "GET" && path === "/api/usage") {
    const usage = runtime.usageExport();
    if (!usage) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="orchestra-usage.json"' })
      .end(JSON.stringify(usage, null, 2));
    return;
  }
  if (request.method === "GET" && path === "/api/image") {
    // Other sites must not load these images, or they could probe which files exist.
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const query = new URL(request.url ?? "", origin).searchParams;
    const image = await loadLocalImage(query.get("path") ?? "", runtime.imageRoots(query.get("agent") ?? undefined));
    if (!("body" in image)) {
      response.writeHead(image.status, { "Content-Type": "text/plain; charset=utf-8" }).end(image.reason);
      return;
    }
    // Revalidate every time so a screenshot regenerated under the same name shows its new contents.
    const headers = { "Cache-Control": "no-cache", ETag: image.etag };
    if (request.headers["if-none-match"] === image.etag) {
      response.writeHead(304, headers).end();
      return;
    }
    // A sandboxed, script-free policy keeps an SVG opened in its own tab from acting on the workspace origin.
    response.writeHead(200, {
      ...headers,
      "Content-Type": image.type,
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
    }).end(image.body);
    return;
  }
  if (request.method === "GET" && path === "/api/skills") {
    const engineName = runtime.snapshot().provider.name === "claude" ? "Claude" : "Codex";
    try {
      const projects = new URL(request.url ?? "/", origin).searchParams.get("projects");
      // Skill file paths stay on the server; the composer only needs names and descriptions.
      const skills = (await runtime.skills(projects ? projects.split(",") : []))
        .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ engine: engineName, skills }));
    } catch (error) {
      response.writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ engine: engineName, error: error instanceof Error ? safeError(error.message) : "Skills could not be listed." }));
    }
    return;
  }
  if (request.method === "GET" && path === "/api/models") {
    const catalog = await runtime.listModels();
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(catalog));
    return;
  }
  if (request.method === "GET" && path === "/api/diff") {
    const agentId = new URL(request.url ?? "", origin).searchParams.get("agentId");
    const sources = agentId ? runtime.diffSources(agentId) : undefined;
    if (!sources) {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "This task is unavailable." }));
      return;
    }
    try {
      const diff = await sharedDiff(JSON.stringify(sources));
      if (!response.destroyed) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(diff));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : "Orchestra could not compute the changes." }));
    }
    return;
  }
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
      const command = await readCommand(request);
      const result = await runtime.command(command);
      if (command.type === "createTask") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ agentId: result }));
      } else response.writeHead(204).end();
    } catch (error) {
      const tooLarge = error instanceof CommandTooLarge;
      response.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json", ...(tooLarge ? { Connection: "close" } : {}) })
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

function listen() {
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;
  server.listen(port, "127.0.0.1");
}
server.on("listening", () => {
  runtime = new WorkspaceRuntime({
    cwd,
    projects,
    demo: !live,
    modelProvider,
    engine,
    // Provider IDs cannot contain ":", so Claude state never shares a file with a Codex provider.
    store: live ? workspaceStore(identity, undefined, engine === "claude" ? "engine:claude" : modelProvider) : undefined,
  });
  const mode = !live ? "demo" : engine === "claude" ? "Claude" : modelProvider === "openai" ? "Codex" : `Codex: ${modelProvider}`;
  console.log(`Orchestra (${mode}) is available at ${origin}`);
  void runtime.start().catch((error) => console.error("Workspace startup failed:", error instanceof Error ? error.message : error));
});
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" && !fixedPort && port < preferredPort + 20) {
    port++;
    listen();
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});
listen();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
    void runtime?.close().catch((error) => console.error("Workspace shutdown failed:", error));
  });
}
