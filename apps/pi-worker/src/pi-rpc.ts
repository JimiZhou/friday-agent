/** Package version which must be installed in the immutable worker image. */
export const PI_CODING_AGENT_VERSION = "0.84.1" as const;

export interface PiModelConfig {
  readonly baseUrl: URL;
  readonly model: string;
  readonly apiKey: string;
}

export function loadPiModelConfig(env: NodeJS.ProcessEnv = process.env): PiModelConfig | undefined {
  const values = [env.FRIDAY_PI_BASE_URL, env.FRIDAY_PI_MODEL, env.FRIDAY_PI_API_KEY];
  if (values.every((value) => value === undefined || value === "")) return undefined;
  if (values.some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("Pi model configuration must include base URL, model, and API key together");
  let baseUrl: URL;
  try { baseUrl = new URL(env.FRIDAY_PI_BASE_URL as string); } catch { throw new Error("FRIDAY_PI_BASE_URL must be an absolute URL"); }
  const loopback = baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "[::1]";
  if ((baseUrl.protocol !== "https:" && !loopback) || baseUrl.username !== "" || baseUrl.password !== "") throw new Error("FRIDAY_PI_BASE_URL must be HTTPS or an explicit loopback endpoint without credentials");
  if (baseUrl.pathname === "" || !baseUrl.pathname.endsWith("/")) throw new Error("FRIDAY_PI_BASE_URL must end with a path slash");
  if (!/^[A-Za-z0-9._:/-]{1,256}$/.test(env.FRIDAY_PI_MODEL as string)) throw new Error("FRIDAY_PI_MODEL is invalid");
  if ((env.FRIDAY_PI_API_KEY as string).length < 16 || (env.FRIDAY_PI_API_KEY as string).length > 1024 || /\s/.test(env.FRIDAY_PI_API_KEY as string)) throw new Error("FRIDAY_PI_API_KEY is invalid");
  return { baseUrl, model: env.FRIDAY_PI_MODEL as string, apiKey: env.FRIDAY_PI_API_KEY as string };
}

/** This launch plan is consumed only inside a digest-pinned sandbox image. */
export function piRpcLaunchPlan(config: PiModelConfig | undefined): { readonly executable: "pi"; readonly arguments: readonly ["--mode", "rpc"]; readonly environment: Readonly<Record<string, string>> } {
  if (config === undefined) throw new Error("PI_MODEL_NOT_CONFIGURED: refusing to launch Pi without private model configuration");
  return Object.freeze({ executable: "pi", arguments: Object.freeze(["--mode", "rpc"] as const), environment: Object.freeze({ PI_OPENAI_BASE_URL: config.baseUrl.toString(), PI_MODEL: config.model, PI_API_KEY: config.apiKey }) });
}
