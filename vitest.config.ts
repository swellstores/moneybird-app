import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type SdkAuth = {
  storeId: string;
  sessionId: string;
  apiBaseUrl: string;
};

const isCI = Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION);

function loadSwellAuth(): SdkAuth {
  const envStoreId = process.env.SWELL_STORE_ID;
  const envSessionId = process.env.SWELL_SESSION_ID;
  const envApiBaseUrl = process.env.SWELL_API_BASE_URL;

  if (envStoreId && envSessionId) {
    return {
      storeId: envStoreId,
      sessionId: envSessionId,
      apiBaseUrl: envApiBaseUrl || `https://${envStoreId}.swell.store/admin/api`,
    };
  }

  if (isCI) {
    throw new Error(
      "CI environment detected but SWELL_STORE_ID and SWELL_SESSION_ID are not set. " +
        "Add these as CI secrets/variables to run integration tests.",
    );
  }

  const home = homedir();
  const configPath = path.resolve(home, ".swell", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `Swell CLI config not found at ${configPath}. Run \`swell login\` or set SWELL_STORE_ID and SWELL_SESSION_ID.`
    );
  }

  const rawConfig = readFileSync(configPath, "utf-8");

  interface CliConfig {
    defaultStore?: string;
    stores?: { storeId: string; sessionId?: string }[];
  }

  let configJson: CliConfig;

  try {
    configJson = JSON.parse(rawConfig) as CliConfig;
  } catch (error) {
    throw new Error(
      `Unable to parse Swell CLI config at ${configPath}: ${String(error)}`
    );
  }

  const defaultStore = configJson.defaultStore;
  const stores = configJson.stores || [];

  const store = defaultStore
    ? stores.find((item) => item.storeId === defaultStore)
    : undefined;

  if (!defaultStore || !store?.sessionId) {
    throw new Error(
      "No active Swell CLI session found. Run \`swell login\` or set SWELL_STORE_ID and SWELL_SESSION_ID.",
    );
  }

  const envPath = path.join(home, ".swell", "env.json");
  let apiBaseUrl = `https://${defaultStore}.swell.store/admin/api`;

  if (existsSync(envPath)) {
    try {
      const rawEnv = readFileSync(envPath, "utf-8");
      const envJson = JSON.parse(rawEnv) as { ADMIN_API_BASE_URL?: string };
      if (envJson.ADMIN_API_BASE_URL) {
        apiBaseUrl = envJson.ADMIN_API_BASE_URL.replace("${STORE_ID}", defaultStore);
      }
    } catch {
      // Ignore env parsing errors and fall back to default
    }
  }

  return {
    storeId: defaultStore,
    sessionId: store.sessionId!,
    apiBaseUrl,
  };
}

const sdkAuth = loadSwellAuth();

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "docs"],
    setupFiles: ["./test/setup-globals.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: true,
        miniflare: {
          bindings: {
            SWELL_STORE_ID: sdkAuth.storeId,
            SWELL_SESSION_ID: sdkAuth.sessionId,
            SWELL_API_BASE_URL: sdkAuth.apiBaseUrl,
            SWELL_APP_ID: "moneybird",
            SWELL_ENVIRONMENT: "test",
          },
        },
      },
    },
  },
});
