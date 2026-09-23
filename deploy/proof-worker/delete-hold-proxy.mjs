import { createServer, request as upstreamRequest } from "node:http";
import { writeFile } from "node:fs/promises";

const listenPort = Number(process.env.PROXY_PORT);
const minioPort = Number(process.env.MINIO_PORT);
const markerPath = process.env.DELETE_MARKER_PATH ?? "";
if (!Number.isInteger(listenPort) || !Number.isInteger(minioPort) || !markerPath) {
  throw new Error("Proxy and marker settings are required.");
}

const server = createServer(async (incoming, outgoing) => {
  if (incoming.method === "DELETE") {
    await writeFile(markerPath, "delete reached proxy");
    incoming.resume();
    incoming.on("aborted", () => outgoing.destroy());
    return;
  }
  const upstream = upstreamRequest({
    hostname: "127.0.0.1",
    port: minioPort,
    method: incoming.method,
    path: incoming.url,
    headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
