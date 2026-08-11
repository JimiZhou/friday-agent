#!/usr/bin/env node

import { PiSupervisor } from "./supervisor.js";
export { PI_CODING_AGENT_VERSION, loadPiModelConfig, piRpcLaunchPlan, type PiModelConfig } from "./pi-rpc.js";
export { PiRpcProxy, type PiRpcProxyOptions } from "./pi-proxy.js";
import { pathToFileURL } from "node:url";

export { PiSupervisor, type PiSupervisorOptions } from "./supervisor.js";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const supervisor = new PiSupervisor();
  supervisor.run();
}
