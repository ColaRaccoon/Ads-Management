import { AppRole } from "@prisma/client";
import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { InviteUserDto } from "./dto/invite-user.dto";
import { UsersController } from "./users.controller";

const actor = { id: "11111111-1111-4111-8111-111111111111" } as never;
const request = {} as never;

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
});
