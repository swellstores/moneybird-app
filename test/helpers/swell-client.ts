import { env } from "cloudflare:test";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type BasicSwellClient = Pick<
  SwellAPI,
  "get" | "post" | "put" | "delete" | "settings"
>;

async function makeRequest(
  method: HttpMethod,
  url: string,
  data?: any
): Promise<any> {
  const baseUrl = env.SWELL_API_BASE_URL || "https://api.swell.store";
  const sessionId = env.SWELL_SESSION_ID;
  const environment = env.SWELL_ENVIRONMENT || "test";

  if (!sessionId) {
    throw new Error(
      "Missing SWELL_SESSION_ID binding. Run \`swell login\` or set it explicitly for tests.",
    );
  }

  let endpointUrl = String(url).startsWith("/") ? url.substring(1) : String(url);
  if (!endpointUrl.startsWith("data/")) {
    endpointUrl = `data/${endpointUrl}`;
  }

  let fullUrl = `${baseUrl}/${endpointUrl}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": "swell-app-tests/1.0",
    "X-Session": sessionId,
    "Swell-Env": environment,
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (data) {
    if (method === "GET") {
      const params = new URLSearchParams();

      function append(prefix: string, value: any) {
        if (value === null || value === undefined) return;
        if (typeof value === "object" && !Array.isArray(value)) {
          for (const [k, v] of Object.entries(value)) {
            append(`${prefix}[${k}]`, v);
          }
        } else if (Array.isArray(value)) {
          for (const v of value) {
            append(`${prefix}[]`, v);
          }
        } else {
          params.append(prefix, String(value));
        }
      }

      for (const [key, value] of Object.entries(data)) {
        append(key, value);
      }

      const query = params.toString();
      if (query) {
        fullUrl += `?${query}`;
      }
    } else {
      options.body = JSON.stringify(data);
    }
  }

  const response = await fetch(fullUrl, options);
  const text = await response.text();

  let result: any;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text;
  }

  if (!response.ok) {
    throw new (globalThis as any).SwellError(result || text || "Request failed", {
      status: response.status,
    });
  }

  if (result?.errors) {
    throw new (globalThis as any).SwellError(result.errors, {
      status: 400,
    });
  }

  return result;
}

export function createSwellClient(): BasicSwellClient {
  return {
    get(url: string, query?: any) {
      return makeRequest("GET", url, query);
    },
    post(url: string, data?: any) {
      return makeRequest("POST", url, data);
    },
    put(url: string, data?: any) {
      return makeRequest("PUT", url, data);
    },
    delete(url: string, data?: any) {
      return makeRequest("DELETE", url, data);
    },
    settings(id?: string) {
      const appId = id || env.SWELL_APP_ID;
      if (!appId) {
        throw new Error(
          "Missing app id. Pass an id to settings() or set SWELL_APP_ID binding.",
        );
      }
      return makeRequest("GET", `/settings/${appId}`);
    },
  } as BasicSwellClient;
}
