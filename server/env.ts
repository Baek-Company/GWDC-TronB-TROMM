import fs from "node:fs";
import path from "node:path";

// .env.local을 명시적으로 읽는다. 값은 이 프로세스 안에서만 쓰고 응답·로그에 넣지 않는다.
function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, "").trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(path.resolve(process.cwd(), ".env.local"));
const get = (k: string, def = "") => process.env[k] ?? fileEnv[k] ?? def;

export const env = {
  llmProvider: get("LLM_PROVIDER", "nim") as "nim" | "tron" | "template",
  nimBaseUrl: get("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1"),
  nimApiKey: get("NIM_API_KEY"),
  nimModel: get("NIM_MODEL", "openai/gpt-oss-20b"),
  llmTimeoutMs: Number(get("LLM_TIMEOUT_MS", "45000")),
  tronLlmBaseUrl: get("TRON_LLM_BASE_URL"),
  tronLlmApiKey: get("TRON_LLM_API_KEY"),
  tronLlmModel: get("TRON_LLM_MODEL"),
  trongridApiKey: get("TRONGRID_API_KEY"),
  mcpJustlendCommand: get("MCP_JUSTLEND_COMMAND"),
  mcpUsddCommand: get("MCP_USDD_COMMAND"),
  mcpTrongridEnabled: get("MCP_TRONGRID_ENABLED", "false") === "true",
  dataMode: (get("DATA_MODE", "synthetic") === "live" ? "live" : "synthetic") as "live" | "synthetic",
  enableNileExecution: get("ENABLE_NILE_EXECUTION", "false") === "true",
  apiPort: Number(get("API_PORT", "8787")),
};

/** 비밀이 아닌 설정 여부만 공개한다 */
export function publicConfig() {
  return {
    llmProvider: env.llmProvider,
    llmModel: env.llmProvider === "nim" ? env.nimModel : env.tronLlmModel || undefined,
    nimKeyConfigured: Boolean(env.nimApiKey),
    tronLlmConfigured: Boolean(env.tronLlmApiKey && env.tronLlmBaseUrl),
    trongridKeyConfigured: Boolean(env.trongridApiKey),
    dataMode: env.dataMode,
    enableNileExecution: env.enableNileExecution,
    mcp: {
      justlend: Boolean(env.mcpJustlendCommand),
      usdd: Boolean(env.mcpUsddCommand),
      trongrid: env.mcpTrongridEnabled,
    },
  };
}

/** 로그·오류 메시지에서 키를 지운다 */
export function redact(s: string): string {
  let out = s;
  for (const secret of [env.nimApiKey, env.tronLlmApiKey, env.trongridApiKey]) {
    if (secret && secret.length > 4) out = out.split(secret).join("***");
  }
  return out;
}
