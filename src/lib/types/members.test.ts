import { describe, it, expect } from "vitest";
import {
  assignableRoles,
  canActOnTarget,
  canManageMembers,
  isValidEmail,
  type MemberRole,
} from "./members";

describe("canManageMembers", () => {
  it("is true only for owner + admin", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("viewer")).toBe(false);
    expect(canManageMembers(null)).toBe(false);
    expect(canManageMembers(undefined)).toBe(false);
  });
});

describe("canActOnTarget", () => {
  it("lets an owner act on any role", () => {
    for (const t of ["owner", "admin", "editor", "viewer"] as MemberRole[]) {
      expect(canActOnTarget("owner", t)).toBe(true);
    }
  });

  it("lets an admin act on everyone except owners", () => {
    expect(canActOnTarget("admin", "owner")).toBe(false);
    expect(canActOnTarget("admin", "admin")).toBe(true);
    expect(canActOnTarget("admin", "editor")).toBe(true);
    expect(canActOnTarget("admin", "viewer")).toBe(true);
  });

  it("denies editors and viewers entirely", () => {
    expect(canActOnTarget("editor", "viewer")).toBe(false);
    expect(canActOnTarget("viewer", "viewer")).toBe(false);
  });
});

describe("assignableRoles", () => {
  it("owner may grant any role (incl. transferring ownership)", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "editor", "viewer"]);
  });

  it("admin may grant admin/editor/viewer but never owner", () => {
    expect(assignableRoles("admin")).toEqual(["admin", "editor", "viewer"]);
    expect(assignableRoles("admin")).not.toContain("owner");
  });

  it("non-managers may grant nothing", () => {
    expect(assignableRoles("editor")).toEqual([]);
    expect(assignableRoles("viewer")).toEqual([]);
  });
});

describe("isValidEmail", () => {
  it("accepts plausible addresses", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("teammate@example.com")).toBe(true);
  });
  it("rejects malformed ones", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a @b.co")).toBe(false);
  });
});
