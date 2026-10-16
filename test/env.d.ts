declare module "cloudflare:test" {
  interface ProvidedEnv {
    SWELL_STORE_ID: string;
    SWELL_SESSION_ID: string;
    SWELL_API_BASE_URL: string;
    SWELL_APP_ID: string;
    SWELL_ENVIRONMENT?: string;
  }
}

export {};
