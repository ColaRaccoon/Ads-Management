import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { SetInitialPasswordDto } from "./set-initial-password.dto";
import { validateNewPassword } from "../local-credentials";

describe("password length boundary", () => {
  it.each([6, 7, 128, 129])("validates %i characters consistently", (length) => {
    const password = "a".repeat(length);
    const dto = Object.assign(new SetInitialPasswordDto(), { password });
    const allowed = length >= 7 && length <= 128;
    expect(validateSync(dto).length === 0).toBe(allowed);
    if (allowed) expect(() => validateNewPassword(password)).not.toThrow();
    else expect(() => validateNewPassword(password)).toThrow();
  });
});
