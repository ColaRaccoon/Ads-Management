import { Body, Controller, Get, Headers, Inject, Optional, Param, ParseUUIDPipe, Patch, Post, Req, Res, UsePipes, ValidationPipe } from "@nestjs/common";
import { Request, Response } from "express";
import { AuthRequestSecurityService } from "../auth/request-security.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { InviteUserDto } from "./dto/invite-user.dto";
import { ReconcileInvitationDto } from "./dto/reconcile-invitation.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UsersService } from "./users.service";
import { AUTH_CONFIG, AuthConfig } from "../auth/auth.config";
import { LocalUsersService } from "./local-users.service";
import { userLifecycleError } from "./user-lifecycle.errors";

const strictBodyPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true
});

@Controller("users")
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuthRequestSecurityService) private readonly requestSecurity: AuthRequestSecurityService,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
    @Optional() @Inject(LocalUsersService) private readonly localUsers?: LocalUsersService
  ) {}

  @Get()
  @RequirePermissions("users.manage")
  list(@Res({ passthrough: true }) response: Response) {
    setNoStore(response);
    return this.config?.provider === "local" && this.localUsers
      ? this.localUsers.list()
      : this.users.list();
  }

  @Post("invitations")
  @RequirePermissions("users.manage")
  @UsePipes(strictBodyPipe)
  async invite(
    @Body() body: InviteUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
    @Headers("idempotency-key") requestId?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    setNoStore(response);
    await this.requestSecurity.assertCsrfMutation(request, "users");
    if (this.config?.provider === "local" && this.localUsers) {
      if (!body.username || body.email !== undefined) throw userLifecycleError("USERNAME_INVALID");
      return this.localUsers.invite(body, actor.id, requestId);
    }
    if (body.username !== undefined) throw userLifecycleError("USER_EMAIL_INVALID");
    return this.users.invite(body, actor.id, requestId);
  }

  @Patch(":id")
  @RequirePermissions("users.manage")
  @UsePipes(strictBodyPipe)
  async update(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response?: Response
  ) {
    setNoStore(response);
    await this.requestSecurity.assertCsrfMutation(request, "users");
    return this.config?.provider === "local" && this.localUsers
      ? this.localUsers.update(id, body, actor.id)
      : this.users.update(id, body, actor.id);
  }

  @Post(":id/password-reset")
  @RequirePermissions("users.manage")
  async resetPassword(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response?: Response
  ) {
    setNoStore(response);
    await this.requestSecurity.assertCsrfMutation(request, "users");
    if (this.config?.provider !== "local" || !this.localUsers) {
      throw userLifecycleError("INVALID_USER_TRANSITION");
    }
    return this.localUsers.resetPassword(id, actor.id);
  }

  @Post(":id/reconcile-invitation")
  @RequirePermissions("users.manage")
  @UsePipes(strictBodyPipe)
  async reconcile(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ReconcileInvitationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response?: Response
  ) {
    setNoStore(response);
    await this.requestSecurity.assertCsrfMutation(request, "users");
    if (this.config?.provider === "local") throw userLifecycleError("INVALID_USER_TRANSITION");
    return this.users.reconcile(id, body.action, actor.id);
  }
}

function setNoStore(response?: Response) {
  if (!response) return;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
}
