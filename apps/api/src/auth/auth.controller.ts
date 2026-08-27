import { Body, Controller, Get, HttpCode, Inject, Optional, Post, Req, Res, UsePipes, ValidationPipe } from "@nestjs/common";
import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { AuthCookieService } from "./cookie.service";
import { LoginDto } from "./dto/login.dto";
import { normalizeEmail } from "./email-normalizer";
import { AuthRequestSecurityService } from "./request-security.service";
import { Authenticated, CurrentUser, Public } from "./route-decorators";
import { AuthenticatedUser } from "./auth.types";
import { authError, AuthHttpException } from "./auth.errors";
import { AcceptInvitationDto } from "./dto/accept-invitation.dto";
import { SetInitialPasswordDto } from "./dto/set-initial-password.dto";
import { invitationError } from "./invitation.errors";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { LocalAuthService } from "./local-auth.service";
import { normalizeUsername } from "./local-credentials";

const strictBodyPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true
});

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookieService,
    private readonly requestSecurity: AuthRequestSecurityService,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
    @Optional() private readonly localAuth?: LocalAuthService
  ) {}

  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    setNoStore(response);
    if (this.config?.provider === "local") {
      if (!this.localAuth || !body.username || body.email !== undefined) throw authError("INVALID_CREDENTIALS");
      let normalizedUsername: string;
      try { normalizedUsername = normalizeUsername(body.username); }
      catch { throw authError("INVALID_CREDENTIALS"); }
      await this.requestSecurity.assertLoginRequest(request, normalizedUsername);
      const result = await this.localAuth.login(normalizedUsername, body.password);
      this.cookies.setLocalSessionCookies(response, result.sessionToken);
      return result.response;
    }
    if (body.username !== undefined) throw authError("INVALID_CREDENTIALS");
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(body.email ?? "");
    } catch {
      throw authError("INVALID_CREDENTIALS");
    }
    await this.requestSecurity.assertLoginRequest(request, normalizedEmail);
    const result = await this.authService.login(normalizedEmail, body.password);
    this.cookies.setAuthenticatedCookies(response, result.cookies);
    setNoStore(response);
    return result.response;
  }

  @Post("refresh")
  @Public()
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    setNoStore(response);
    this.requestSecurity.assertMutationOrigin(request);
    const refreshToken = this.cookies.readRefreshToken(request);
    const sessionHandle = this.cookies.readSessionHandle(request);
    if (this.config?.provider !== "local" && !refreshToken) {
      this.cookies.clearAuthenticationCookies(response);
      throw authError("AUTHENTICATION_REQUIRED");
    }
    if (!sessionHandle) {
      this.cookies.clearAuthenticationCookies(response);
      throw authError("SESSION_INVALID");
    }
    await this.requestSecurity.assertSessionCsrfAndRate(request, "refresh");

    try {
      if (this.config?.provider === "local") {
        if (!this.localAuth) throw authError("SESSION_INVALID");
        const result = await this.localAuth.refresh(sessionHandle);
        this.cookies.setLocalSessionCookies(response, result.sessionToken);
        return result.response;
      }
      const result = await this.authService.refresh(refreshToken, sessionHandle);
      if ("recoveryRefreshToken" in result) {
        this.cookies.setRefreshCookie(response, result.recoveryRefreshToken);
        throw authError("AUTH_PROVIDER_UNAVAILABLE");
      }
      this.cookies.setAuthenticatedCookies(response, result.cookies);
      return result.response;
    } catch (error) {
      const preserveCookies =
        error instanceof AuthHttpException &&
        (error.code === "REFRESH_RACE_RETRY" || error.code === "AUTH_PROVIDER_UNAVAILABLE");
      if (!preserveCookies) {
        this.cookies.clearAuthenticationCookies(response);
      }
      throw error;
    }
  }

  @Post("logout")
  @Public()
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    setNoStore(response);
    await this.requestSecurity.assertSessionMutation(request, "logout");
    try {
      if (this.config?.provider === "local") {
        await this.localAuth?.logout(this.cookies.readSessionHandle(request));
      } else {
        await this.authService.logout(
          this.cookies.readSessionHandle(request),
          this.cookies.readAccessToken(request),
          this.cookies.readRefreshToken(request)
        );
      }
    } finally {
      this.cookies.clearAuthenticationCookies(response);
    }
  }

  @Get("me")
  @Authenticated()
  me(@CurrentUser() principal: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    setNoStore(response);
    return this.config?.provider === "local" && this.localAuth
      ? this.localAuth.me(principal)
      : this.authService.me(principal);
  }

  @Post("invitations/accept")
  @Public()
  @HttpCode(200)
  @UsePipes(strictBodyPipe)
  async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    setNoStore(response);
    await this.requestSecurity.assertInvitationAccept(request, body.tokenHash);
    const currentSession = this.cookies.readSessionHandle(request);
    const hasSession = this.config?.provider === "local"
      ? await this.localAuth?.hasActiveBrowserSession(currentSession)
      : await this.authService.hasActiveBrowserSession(currentSession);
    if (hasSession) {
      throw invitationError("ACTIVE_SESSION_PRESENT");
    }
    if (this.config?.provider === "local") {
      if (!this.localAuth) throw authError("AUTH_PROVIDER_UNAVAILABLE");
      const result = await this.localAuth.acceptSetupToken(body.tokenHash);
      this.cookies.setLocalSessionCookies(response, result.sessionToken);
      return result.response;
    }
    const result = await this.authService.acceptInvitation(body.tokenHash);
    this.cookies.setAuthenticatedCookies(response, result.cookies);
    return result.response;
  }

  @Post("password")
  @Authenticated()
  @HttpCode(200)
  @UsePipes(strictBodyPipe)
  async setInitialPassword(
    @Body() body: SetInitialPasswordDto,
    @CurrentUser() principal: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    setNoStore(response);
    await this.requestSecurity.assertCsrfMutation(request, "password");
    if (this.config?.provider === "local") {
      if (!this.localAuth) throw invitationError("ONBOARDING_SESSION_REQUIRED");
      const result = await this.localAuth.completeInitialPassword(principal, body.password);
      this.cookies.setLocalSessionCookies(response, result.sessionToken);
      return result.response;
    }
    const accessToken = this.cookies.readAccessToken(request);
    if (!accessToken) throw invitationError("ONBOARDING_SESSION_REQUIRED");
    return this.authService.completeInitialPassword(principal, accessToken, body.password);
  }
}

function setNoStore(response: Response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
}
