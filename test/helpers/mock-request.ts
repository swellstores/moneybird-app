import { env } from "cloudflare:test";
import { createSwellClient } from "./swell-client";

export interface MockRequestOptions {
  data?: SwellData;
  query?: { [key: string]: string };
  session?: { [key: string]: any };
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  swell?: Partial<SwellAPI>;
  store?: Partial<SwellStore>;
  appId?: string;
  useRealSwell?: boolean;
}

function createDefaultSwellMock(): Partial<SwellAPI> {
  const notMocked = (method: string) => () => {
    throw new Error(
      `swell.${method}() not mocked. Pass { swell: { ${method}: vi.fn() } } to createMockRequest().`
    );
  };
  return {
    get: notMocked("get"),
    post: notMocked("post"),
    put: notMocked("put"),
    delete: notMocked("delete"),
    settings: notMocked("settings"),
  };
}

export function createMockRequest(options: MockRequestOptions = {}): SwellRequest {
  const {
    data = {},
    query = {},
    session = {},
    headers = {},
    method = "POST",
    url = "https://example.com/test",
    swell,
    store,
    appId,
    useRealSwell = false,
  } = options;

  const requestHeaders = new Headers(headers);
  const originalRequest = new Request(url, {
    method,
    headers: requestHeaders,
    body: method === "GET" ? undefined : JSON.stringify(data),
  });

  const storeId = store?.id || env.SWELL_STORE_ID || "test-store";

  const resolvedStore = {
    id: storeId,
    url: store?.url || "",
    admin_url: store?.admin_url || "",
  };

  const context = {
    waitUntil: async (promise: Promise<unknown>) => {
      await promise;
    },
  };

  const swellClient =
    swell || (useRealSwell ? createSwellClient() : createDefaultSwellMock());

  const resolvedAppId = appId || env.SWELL_APP_ID || "moneybird";

  const req: Partial<SwellRequest> & { appId: string; storeId: string } = {
    originalRequest,
    context,
    url: new URL(url),
    method,
    headers: requestHeaders,
    referrer: originalRequest.referrer,
    credentials: "include",
    appId: resolvedAppId,
    storeId,
    accessToken: null,
    publicKey: null,
    store: resolvedStore,
    session,
    apiHost: env.SWELL_API_BASE_URL || "",
    logParams: undefined,
    swell: swellClient as SwellAPI,
    body: data,
    data,
    query,
    initialize: async () => {},
    parseJson: (input: string) => JSON.parse(input),
    reject: (
      code: string,
      message: string,
      options: { status?: number } = {}
    ) => {
      const status =
        typeof options.status === "number" &&
        options.status >= 400 &&
        options.status < 500
          ? options.status
          : 422;
      const error = new Error(
        message || "Request rejected by function"
      ) as Error & {
        body: { $reject: { code: string; message: string; status: number } };
        code: string;
        status: number;
      };
      error.name = "SwellRejection";
      error.code = code;
      error.status = status;
      error.body = {
        $reject: {
          code,
          message: error.message,
          status,
        },
      };
      return error;
    },
    appValues: (idOrValues: string | SwellData, values?: SwellData) => {
      const targetAppId =
        typeof idOrValues === "string" ? idOrValues : resolvedAppId;
      const appValues = typeof idOrValues === "string" ? values : idOrValues;
      if (!targetAppId) {
        throw new Error("appValues: missing app id (req.appId is empty)");
      }
      if (
        typeof appValues !== "object" ||
        appValues === null ||
        Object.getPrototypeOf(appValues) !== Object.prototype
      ) {
        throw new Error(
          "appValues: values must be a plain object (arrays, class instances, null, and primitives are not allowed)"
        );
      }
      return {
        $app: {
          [targetAppId]: appValues,
        },
      };
    },
  };

  return req as SwellRequest;
}
