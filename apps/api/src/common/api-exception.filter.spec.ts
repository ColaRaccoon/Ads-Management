import { ArgumentsHost, BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "./api-exception.filter";

describe("ApiExceptionFilter sensitive error handling", () => {
  it.each(["P2002", "P2003", "P2025", "P9999"])("does not expose Prisma meta for %s", (code) => {
    const response = responseFake();
    const error = new Prisma.PrismaClientKnownRequestError("raw database detail", {
      code,
      clientVersion: "test",
      meta: { target: ["private_column"], field_name: "private_field" }
    });
    new ApiExceptionFilter().catch(error, host(response));
    const payload = response.json.mock.calls[0][0];
    expect(payload.details).toBeNull();
    expect(JSON.stringify(payload)).not.toMatch(/private_column|private_field|raw database detail/);
  });

  it("does not expose an unexpected internal error message", () => {
    const response = responseFake();
    new ApiExceptionFilter().catch(new Error("provider raw secret message"), host(response));
    expect(response.json).toHaveBeenCalledWith({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error",
      details: null,
      requestId: "request-123"
    });
  });

  it("never reflects arbitrary HttpException details, provider causes, or input values", () => {
    const response = responseFake();
    new ApiExceptionFilter().catch(new BadRequestException({
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
      details: {
        date: "private-input-date",
        providerCause: "provider secret cause",
        nested: { token: "secret-token" }
      }
    }), host(response));
    expect(response.json).toHaveBeenCalledWith({
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
      details: null,
      requestId: "request-123"
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
      /private-input-date|provider secret cause|secret-token/
    );
  });

  it("turns framework validation arrays into one stable code without echoing input", () => {
    const response = responseFake();
    new ApiExceptionFilter().catch(new BadRequestException([
      "password must be longer than or equal to 12 characters",
      "unknownField should not exist"
    ]), host(response));
    expect(response.json).toHaveBeenCalledWith({
      code: "VALIDATION_FAILED",
      message: "Request validation failed.",
      details: null,
      requestId: "request-123"
    });
  });

  it("sets a bounded Retry-After header for the stable rate-limit envelope", () => {
    const response = responseFake();
    new ApiExceptionFilter().catch(new BadRequestException({
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
      details: { retryAfterSeconds: 17, unsafe: "not returned" }
    }), host(response));
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "17");
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: 17 }
    }));
  });

  it("allowlists only bounded bundle partial-failure field metadata", () => {
    const response = responseFake();
    new ApiExceptionFilter().catch(new ConflictException({
      code: "COUPANG_BUNDLE_PARTIAL_FAILURE",
      message: "The bundle was only partially imported. Retry the complete bundle with SKIP.",
      details: {
        completedFields: ["margin"],
        failedField: "sales",
        retryConflictPolicy: "SKIP",
        filename: "private-orders.xlsx",
        providerMessage: "private provider detail"
      }
    }), host(response));
    expect(response.json).toHaveBeenCalledWith({
      code: "COUPANG_BUNDLE_PARTIAL_FAILURE",
      message: "The bundle was only partially imported. Retry the complete bundle with SKIP.",
      details: {
        completedFields: ["margin"],
        failedField: "sales",
        retryConflictPolicy: "SKIP"
      },
      requestId: "request-123"
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(/private-orders|private provider/);

    const invalidResponse = responseFake();
    new ApiExceptionFilter().catch(new ConflictException({
      code: "COUPANG_BUNDLE_PARTIAL_FAILURE",
      message: "The bundle was only partially imported. Retry the complete bundle with SKIP.",
      details: { completedFields: ["margin", "private"], failedField: "sales", retryConflictPolicy: "SKIP" }
    }), host(invalidResponse));
    expect(invalidResponse.json.mock.calls[0][0].details).toBeNull();
  });
});

function responseFake() {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function host(response: ReturnType<typeof responseFake>) {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ originalUrl: "/api/users", requestId: "request-123" })
    })
  } as unknown as ArgumentsHost;
}
