import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRunnerRelease } from "../apps/fridayctl/dist/bootstrap.js";

const directory = resolve("runner-distribution");
await mkdir(directory, { recursive: true });
const release = await createRunnerRelease(process.cwd(), directory);
console.log(JSON.stringify({ releaseId: release.releaseId, sizeBytes: release.sizeBytes }));
