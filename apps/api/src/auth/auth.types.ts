import { AppRole, InviteStatus } from "@prisma/client";
import { Request } from "express";
import { Permission } from "./role-permissions";

export type VerifiedAccessToken = {
  subject: string;
  sessionId: string;
  expiresAt: number;
};

export type ProviderUser = {
  id: string;
  email: string | null;
  emailVerified: boolean;
};

export type ProviderSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: ProviderUser;
};

export type AuthenticatedUser = {
  id: string;
  authUserId: string;
  email: string | null;
  name: string;
  role: AppRole;
  inviteStatus: InviteStatus;
  isActive: boolean;
  authzVersion: number;
  permissions: Permission[];
  sessionId: string;
};

export type AuthenticatedRequest = Request & {
  authenticatedUser?: AuthenticatedUser;
};

export type AuthUserResponse = {
  user: {
    id: string;
    email: string | null;
    name: string;
    role: AppRole;
    isActive: boolean;
  };
  permissions: Permission[];
  authorizationVersion: string;
};
