class SwellErrorImpl extends Error {
  status: number;
  body?: unknown;

  constructor(message: string | object, options: { status?: number } = {}) {
    const text =
      typeof message === "string"
        ? message
        : JSON.stringify(message, null, 2);

    super(text);
    this.name = "SwellError";
    this.status = options.status ?? 500;
    this.body = typeof message === "string" ? undefined : message;
  }
}

class SwellRejectionImpl extends Error {
  status: number;
  code: string;
  body: {
    $reject: {
      code: string;
      message: string;
      status: number;
    };
  };

  constructor(code: string, message: string, options: { status?: number } = {}) {
    const status =
      typeof options.status === "number" &&
      options.status >= 400 &&
      options.status < 500
        ? options.status
        : 422;

    super(message || "Request rejected by function");
    this.name = "SwellRejection";
    this.status = status;
    this.code = code;
    this.body = {
      $reject: {
        code,
        message: this.message,
        status,
      },
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellError = SwellErrorImpl;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellRejection = SwellRejectionImpl;

export {};
