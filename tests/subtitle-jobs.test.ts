import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepareDownload: vi.fn() }));
vi.mock("../src/services/downloaderService", () => mocks);
import { env } from "../src/config/env";
import { createDownloadJob, getDownloadJob, getDownloadJobFile, shutdownDownloadJobs } from "../src/services/downloadJobService";

it("expands captions per language, packages partial success and retries only exact failed pairs", async () => {
  const original = env.tempRoot;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-caption-job-")); env.tempRoot = root;
  const seen: string[] = [];
  mocks.prepareDownload.mockImplementation(async (request) => {
    seen.push(`${request.format}:${request.subtitleLanguage || "media"}`);
    if (request.subtitleLanguage === "zh-Hant") throw new Error("No zh-Hant subtitles are available.");
    const filePath = path.join(request.tempRoot, `caption-${seen.length}.${request.format}`);
    await fs.writeFile(filePath, "fixture");
    return {filePath,downloadName:path.basename(filePath),cleanup:()=>fs.rm(filePath,{force:true})};
  });
  try {
    const job = createDownloadJob({urls:["https://youtu.be/a"],formats:["vtt","mp3"],subtitleLanguages:["en","zh-Hant"],subtitleSource:"automatic"});
    await vi.waitFor(() => expect(getDownloadJob(job.id).status).toBe("completed"));
    expect(seen).toEqual(["vtt:en","vtt:zh-Hant","mp3:media"]);
    const status = getDownloadJob(job.id);
    expect(status.items.map((item) => item.status)).toEqual(["completed","failed","completed"]);
    expect(status.items[1]).toMatchObject({subtitleLanguage:"zh-Hant",subtitleSource:"automatic"});
    expect((await getDownloadJobFile(job.id)).downloadName).toMatch(/\.zip$/);
    const retry = createDownloadJob({urls:["https://youtu.be/a","https://youtu.be/b"],formats:["mp3","mp4"],items:[{url:"https://youtu.be/a",format:"mp3"},{url:"https://youtu.be/b",format:"mp4"}]});
    await vi.waitFor(() => expect(getDownloadJob(retry.id).status).toBe("completed"));
    expect(seen.slice(3)).toEqual(["mp3:media","mp4:media"]);
    expect(() => createDownloadJob({urls:Array.from({length:30},(_,i)=>`https://youtu.be/${i}`),formats:["srt","vtt"],subtitleLanguages:["en","zh-Hant"]})).toThrow(/60/);
  } finally { await shutdownDownloadJobs(); env.tempRoot=original; await fs.rm(root,{recursive:true,force:true}); }
});
