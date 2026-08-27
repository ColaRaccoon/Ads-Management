import { AppRole } from "@prisma/client";
import { INestApplication, Module, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AuthRequestSecurityService } from "../auth/request-security.service";
import { DangerousJsonKeysPipe } from "../validation/dangerous-json-keys.pipe";
import { InviteUserDto } from "./dto/invite-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

const actor = { id: "11111111-1111-4111-8111-111111111111" } as never;
const request = {} as never;
const httpUsers = {
  list: vi.fn(),
  invite: vi.fn(),
  update: vi.fn(),
  reconcile: vi.fn()
};
const httpSecurity = { assertCsrfMutation: vi.fn() };

// Vitest's fast TS transform does not emit decorator type metadata, so supply the
// same runtime metadata that the production TypeScript build emits for this HTTP test.
Reflect.defineMetadata("design:paramtypes", [UsersService, AuthRequestSecurityService], UsersController);
Reflect.defineMetadata(
  "design:paramtypes",
  [String, UpdateUserDto, Object, Object, Object],
  UsersController.prototype,
  "update"
);

@Module({
  controllers: [UsersController],
  providers: [
    { provide: UsersService, useValue: httpUsers },
    { provide: AuthRequestSecurityService, useValue: httpSecurity }
  ]
})
class StrictUsersTestModule {}

describe("UsersController", () => {
  it("checks exact-origin CSRF before every management mutation", async () => {
    const order: string[] = [];
    const security = {
      assertCsrfMutation: vi.fn(async () => { order.push("security"); })
    };
    const users = {
      invite: vi.fn(async () => { order.push("invite"); return {}; }),
      update: vi.fn(async () => { order.push("update"); return {}; }),
      reconcile: vi.fn(async () => { order.push("reconcile"); return {}; })
    };
    const controller = new UsersController(users as never, security as never);
    await controller.invite({ email: "a@example.com", name: "A", role: AppRole.USER }, actor, request);
    await controller.update("22222222-2222-4222-8222-222222222222", { name: "B" }, actor, request);
    await controller.reconcile(
      "22222222-2222-4222-8222-222222222222",
      { action: "CANCEL" },
      actor,
      request
    );
    expect(order).toEqual(["security", "invite", "security", "update", "security", "reconcile"]);
    expect(security.assertCsrfMutation).toHaveBeenCalledTimes(3);
  });

  it("rejects unknown invitation fields under the endpoint strict DTO contract", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({
      email: "guest@example.com",
      name: "Guest",
      role: "GUEST",
      authUserId: "must-not-be-client-controlled"
    }, { type: "body", metatype: InviteUserDto }))
      .rejects.toMatchObject({ status: 400 });
  });

  it.each(["ü@example.com", "user\u0000@example.com", "user\n@example.com"])(
    "rejects non-printable or non-ASCII invitation email %j at DTO validation",
    async (email) => {
      const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
      await expect(pipe.transform({
        email,
        name: "Guest",
        role: "GUEST"
      }, { type: "body", metatype: InviteUserDto })).rejects.toMatchObject({ status: 400 });
    }
  );

  it("rejects null UpdateUserDto fields in the real global HTTP pipe before controller services run", async () => {
    httpUsers.update.mockClear();
    httpSecurity.assertCsrfMutation.mockClear();
    let app: INestApplication | undefined;
    try {
      app = await NestFactory.create(StrictUsersTestModule, { logger: false, abortOnError: false });
      app.setGlobalPrefix("api");
      app.use((incomingRequest: { authenticatedUser?: typeof actor }, _response: unknown, next: () => void) => {
        incomingRequest.authenticatedUser = actor;
        next();
      });
      app.useGlobalPipes(
        new DangerousJsonKeysPipe(),
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
          transformOptions: { enableImplicitConversion: false },
          validationError: { target: false, value: false }
        })
      );
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as { port: number };
      for (const field of ["name", "role", "isActive"] as const) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/users/22222222-2222-4222-8222-222222222222`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [field]: null })
          }
        );
        const responseBody = await response.text();
        expect(response.status, `${field}: ${responseBody}`).toBe(400);
      }
      expect(httpSecurity.assertCsrfMutation).not.toHaveBeenCalled();
      expect(httpUsers.update).not.toHaveBeenCalled();
    } finally {
      await app?.close();
    }
  });
});
