import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const SCHEMA_ROOT = new URL("../packages/protocol/schemas/", import.meta.url);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("uuid", {
  type: "string",
  validate: (value) => UUID_RE.test(value),
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) => RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value)),
});

function loadSchema(name) {
  return JSON.parse(readFileSync(new URL(name, SCHEMA_ROOT), "utf8"));
}

const validators = {
  inbound: ajv.compile(loadSchema("inbound-message.v1.schema.json")),
  piWorker: ajv.compile(loadSchema("pi-worker-envelope.v1.schema.json")),
  job: ajv.compile(loadSchema("job-spec.v1.schema.json")),
  runner: ajv.compile(loadSchema("runner-envelope.v1.schema.json")),
};

function expectValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function expectInvalid(validate, value) {
  assert.equal(validate(value), false, "expected schema validation to fail");
}

const ids = {
  attachment: "e041195b-4e5c-45ab-a48d-2d14f6029418",
  envelope: "1b2b6ea0-3533-47e7-97e2-44efdc4f6681",
  job: "34795dfb-8ec7-49c6-bf4b-873728b04d12",
  message: "64f86807-4c49-4fae-a252-db159e01c527",
  request: "784cc691-7e64-48d2-9c80-af22a739eed4",
  runner: "8d86b61d-b60f-412d-a434-4d34ee193b31",
  session: "e48a1cab-6f8b-4bf7-b547-c2445bfa42e8",
};

test("InboundMessage v1 accepts normalized content", () => {
  expectValid(validators.inbound, {
    protocolVersion: "1",
    messageId: ids.message,
    channel: "wechat_ilink",
    senderId: "owner-wechat-id",
    conversationId: "conversation-42",
    authStrength: "channel",
    receivedAt: "2026-07-30T09:20:00+08:00",
    content: {
      kind: "mixed",
      text: "请检查这段录音里的报错",
      attachments: [
        {
          attachmentId: ids.attachment,
          kind: "audio",
          mimeType: "audio/ogg",
          sizeBytes: 4096,
          sha256: "a".repeat(64),
          uri: "friday-media://inbound/audio-1",
        },
      ],
    },
  });
});

test("InboundMessage v1 rejects unknown fields, versions, and identifiers", () => {
  const base = {
    protocolVersion: "1",
    messageId: ids.message,
    channel: "web",
    senderId: "owner",
    conversationId: "main",
    authStrength: "strong",
    receivedAt: "2026-07-30T01:20:00Z",
    content: { kind: "text", text: "status" },
  };

  expectInvalid(validators.inbound, { ...base, protocolVersion: "2" });
  expectInvalid(validators.inbound, { ...base, messageId: "not-a-uuid" });
  expectInvalid(validators.inbound, { ...base, messageId: "00000000-0000-0000-0000-000000000000" });
  expectInvalid(validators.inbound, { ...base, receivedAt: "yesterday" });
  expectInvalid(validators.inbound, { ...base, admin: true });
  expectInvalid(validators.inbound, {
    ...base,
    content: { kind: "text", text: "status", rawHtml: "<b>status</b>" },
  });
  expectInvalid(validators.inbound, {
    ...base,
    content: {
      kind: "voice",
      attachment: {
        attachmentId: ids.attachment,
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 128,
        sha256: "a".repeat(64),
        uri: "friday-media://inbound/not-a-voice-recording",
      },
    },
  });
});

test("PiWorkerEnvelope v1 accepts requests, responses, and events", () => {
  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    kind: "request",
    requestId: ids.request,
    operation: "ping",
    payload: null,
  });

  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    kind: "request",
    requestId: ids.request,
    operation: "start",
    payload: {},
  });

  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    kind: "request",
    requestId: ids.request,
    operation: "start",
    payload: { sessionId: ids.session },
  });

  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    sessionId: ids.session,
    kind: "request",
    requestId: ids.request,
    operation: "prompt",
    payload: {
      text: "Inspect the failing build",
      images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
    },
  });

  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:01Z",
    sessionId: ids.session,
    kind: "response",
    requestId: ids.request,
    ok: true,
    payload: { accepted: true },
  });

  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:02Z",
    kind: "response",
    requestId: ids.request,
    ok: false,
    error: {
      code: "WORKER_UNAVAILABLE",
      message: "Pi process is not ready",
      retryable: true,
    },
  });

  expectValid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:03Z",
    sessionId: ids.session,
    kind: "event",
    sequence: 4,
    event: "assistant_delta",
    payload: { text: "I found" },
  });
});

test("PiWorkerEnvelope v1 enforces session and response boundaries", () => {
  const request = {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    kind: "request",
    requestId: ids.request,
    operation: "prompt",
    payload: { text: "inspect" },
  };

  expectInvalid(validators.piWorker, request);
  expectInvalid(validators.piWorker, {
    ...request,
    sessionId: ids.session,
    operation: "start",
  });
  expectInvalid(validators.piWorker, {
    ...request,
    sessionId: ids.session,
    operation: "shell",
  });
  expectInvalid(validators.piWorker, {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    kind: "response",
    requestId: ids.request,
    ok: false,
  });
  expectInvalid(validators.piWorker, {
    ...request,
    sessionId: ids.session,
    root: true,
  });
});

test("PiWorkerEnvelope v1 enforces operation-specific payloads", () => {
  const stateless = {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    sentAt: "2026-07-30T01:20:00Z",
    kind: "request",
    requestId: ids.request,
  };
  const session = { ...stateless, sessionId: ids.session };

  for (const operation of ["abort", "get_state", "compact", "close"]) {
    expectValid(validators.piWorker, { ...session, operation, payload: null });
    expectInvalid(validators.piWorker, { ...session, operation, payload: {} });
  }
  for (const operation of ["prompt", "steer", "follow_up"]) {
    expectValid(validators.piWorker, {
      ...session,
      operation,
      payload: { text: "continue" },
    });
    expectInvalid(validators.piWorker, { ...session, operation, payload: null });
    expectInvalid(validators.piWorker, { ...session, operation, payload: { text: "" } });
    expectInvalid(validators.piWorker, {
      ...session,
      operation,
      payload: { text: "continue", root: true },
    });
    expectInvalid(validators.piWorker, {
      ...session,
      operation,
      payload: { text: "continue", images: [{ type: "image", data: "not-base64", mimeType: "image/png" }] },
    });
    expectInvalid(validators.piWorker, {
      ...session,
      operation,
      payload: { text: "continue", images: [{ type: "image", data: "iVBORw==", mimeType: "image/svg+xml" }] },
    });
  }

  expectInvalid(validators.piWorker, { ...stateless, operation: "ping", payload: {} });
  expectInvalid(validators.piWorker, { ...stateless, operation: "start", payload: null });
  expectInvalid(validators.piWorker, {
    ...stateless,
    operation: "start",
    payload: { sessionId: ids.session, root: true },
  });
});

const approvedJob = {
  protocolVersion: "1",
  jobId: ids.job,
  idempotencyKey: "42412452-46a9-43da-b18b-7e5227adf2dd",
  createdAt: "2026-07-30T01:20:00Z",
  expiresAt: "2026-07-30T02:20:00Z",
  runnerId: ids.runner,
  workspaceId: "friday-agent",
  tool: "codex",
  operation: "develop",
  approval: {
    level: "R2",
    status: "approved",
    approvedBy: "owner-passkey",
    approvedAt: "2026-07-30T01:21:00Z",
    manifestSha256: "b".repeat(64),
  },
  limits: {
    timeoutSeconds: 3600,
    maxOutputBytes: 10485760,
    maxCostUsd: 10,
  },
  network: {
    mode: "restricted",
    allowedHosts: ["api.openai.com", "github.com"],
  },
  secrets: ["model/openai", "git/github"],
  input: {
    prompt: "Implement the protocol package and run its tests.",
    context: { branch: "main", cleanWorktreeRequired: true },
  },
};

test("JobSpec v1 accepts a bounded approved job", () => {
  expectValid(validators.job, approvedJob);

  expectValid(validators.job, {
    ...approvedJob,
    approval: { level: "R0", status: "not_required" },
    network: { mode: "none", allowedHosts: [] },
    secrets: [],
  });
});

test("JobSpec v1 rejects unbounded or inconsistent authority", () => {
  expectInvalid(validators.job, { ...approvedJob, protocolVersion: "latest" });
  expectInvalid(validators.job, { ...approvedJob, runnerId: "local-machine" });
  expectInvalid(validators.job, { ...approvedJob, workspacePath: "/" });
  expectInvalid(validators.job, {
    ...approvedJob,
    approval: { level: "R2", status: "approved", approvedBy: "owner" },
  });
  expectInvalid(validators.job, {
    ...approvedJob,
    network: { mode: "none", allowedHosts: ["github.com"] },
  });
  expectInvalid(validators.job, {
    ...approvedJob,
    limits: { ...approvedJob.limits, timeoutSeconds: 0 },
  });
});

test("RunnerEnvelope v1 accepts registration, heartbeat, and state events", () => {
  const common = {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    runnerId: ids.runner,
    sentAt: "2026-07-30T01:20:00Z",
  };

  expectValid(validators.runner, {
    ...common,
    kind: "register",
    payload: {
      displayName: "Home Mac mini",
      version: "0.2.1",
      capabilities: ["orchestration"],
      workspaces: ["friday-agent"],
      shellExecution: false,
    },
  });

  expectValid(validators.runner, {
    ...common,
    kind: "heartbeat",
    payload: { status: "online", activeJobs: 1 },
  });

  expectValid(validators.runner, {
    ...common,
    kind: "event",
    payload: {
      jobId: ids.job,
      sequence: 5,
      event: "state",
      state: "RECONCILING",
    },
  });
});

test("RunnerEnvelope v1 rejects mismatched and extensible-by-accident payloads", () => {
  const common = {
    protocolVersion: "1",
    envelopeId: ids.envelope,
    runnerId: ids.runner,
    sentAt: "2026-07-30T01:20:00Z",
  };

  expectInvalid(validators.runner, {
    ...common,
    kind: "heartbeat",
    payload: { status: "idle", activeJobs: 0 },
  });
  expectInvalid(validators.runner, {
    ...common,
    kind: "heartbeat",
    payload: { status: "online", activeJobs: [] },
  });
  expectInvalid(validators.runner, {
    ...common,
    kind: "event",
    payload: {
      jobId: ids.job,
      sequence: 1,
      event: "state",
      state: "RETRYING",
    },
  });
  expectInvalid(validators.runner, {
    ...common,
    kind: "register",
    payload: {
      displayName: "Unsafe runner",
      version: "0.2.1",
      capabilities: ["shell"],
      workspaces: ["friday-agent"],
      shellExecution: true,
    },
  });
  expectInvalid(validators.runner, {
    ...common,
    kind: "register",
    payload: {
      displayName: "Missing declaration",
      version: "0.2.1",
      capabilities: ["orchestration"],
      workspaces: ["friday-agent"],
    },
  });
  expectInvalid(validators.runner, {
    ...common,
    kind: "register",
    payload: {
      displayName: "Contradictory runner",
      version: "0.2.1",
      capabilities: ["shell"],
      workspaces: ["friday-agent"],
      shellExecution: false,
    },
  });
  expectInvalid(validators.runner, {
    ...common,
    kind: "heartbeat",
    payload: { status: "online", activeJobs: 0 },
    token: "must-not-cross-wire",
  });
});
