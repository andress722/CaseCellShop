export type ErrorCode =
  | "VALIDATION_ERROR"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "PRODUCT_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "OUT_OF_STOCK"
  | "ERP_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const errorSchema = {
  type: "object",
  required: ["error"] as string[],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"] as string[],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
    },
  },
} as const;
