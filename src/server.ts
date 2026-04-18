import { createApp } from "./app";
import { env } from "./config/env";

const app = createApp();

app.listen(env.port, () => {
  console.log(`YouTube downloader server running at http://localhost:${env.port}`);
});
