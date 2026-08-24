import { AppRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, permissionsForRole, ROLE_PERMISSIONS } from "./role-permissions";

describe("role permissions", () => {
  it("keeps SUPER_ADMIN as the only role with security administration permissions", () => {
    expect(ROLE_PERMISSIONS[AppRole.SUPER_ADMIN]).toEqual(PERMISSIONS);
    for (const role of [AppRole.ADMIN, AppRole.USER, AppRole.GUEST]) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("users.manage");
      expect(ROLE_PERMISSIONS[role]).not.toContain("audit.read");
      expect(ROLE_PERMISSIONS[role]).not.toContain("settings.manage");
    }
  });

  it("implements the approved ADMIN, USER, and GUEST boundary", () => {
    expect(ROLE_PERMISSIONS[AppRole.ADMIN]).toContain("operations.run");
    expect(ROLE_PERMISSIONS[AppRole.ADMIN]).not.toContain("settings.manage");
    expect(ROLE_PERMISSIONS[AppRole.USER]).toEqual([
      "data.read",
      "change_logs.create",
      "reports.generate"
    ]);
    expect(ROLE_PERMISSIONS[AppRole.GUEST]).toEqual(["data.read"]);
  });

  it("returns a copy rather than the central immutable mapping", () => {
    const permissions = permissionsForRole(AppRole.GUEST);
    permissions.length = 0;
    expect(ROLE_PERMISSIONS[AppRole.GUEST]).toEqual(["data.read"]);
  });
});
