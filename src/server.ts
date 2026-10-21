import { createApp } from "./app";
import { shutdownDownloadJobs } from "./services/downloadJobService";
import { env } from "./config/env";

const app = createApp();

const server = app.listen(env.port, env.host, () => {
  console.log(`YouTube downloader server running at http://${env.host}:${env.port}`);
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    await Promise.all([shutdownDownloadJobs(), closed]);
  } catch {
    console.error("Server shutdown could not clean all download artifacts.");
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
