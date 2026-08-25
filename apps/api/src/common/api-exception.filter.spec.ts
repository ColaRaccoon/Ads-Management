import { ArgumentsHost } from "@nestjs/common";
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
      details: null
    });
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
      getRequest: () => ({ originalUrl: "/api/users" })
    })
  } as unknown as ArgumentsHost;
}
