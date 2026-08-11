#!/usr/bin/env node
// A deliberately capability-free stand-in for Codex app-server used only to
// exercise the M1 Runner -> sandboxd execution protocol without model access.
if (process.env.FRIDAY_JOB_ID === undefined || process.env.FRIDAY_JOB_PROMPT === undefined) {
  process.stderr.write("fixture requires a signed Job context\n");
  process.exitCode = 64;
} else {
  process.stdout.write(`${JSON.stringify({ kind: "fixture-app-server", jobId: process.env.FRIDAY_JOB_ID, network: "none" })}\n`);
}
