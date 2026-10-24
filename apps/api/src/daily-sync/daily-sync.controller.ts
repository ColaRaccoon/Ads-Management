import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { Prisma, SyncTrigger } from "@prisma/client";
import { CurrentUser, MachineSync, Public, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../common/prisma.service";
import { HeavyOperation } from "../common/heavy-operation";
import { ConnectionInput, ConnectionListQuery, CoverageQuery, GoogleVerificationInput, MetaVerificationInput, IdParam, MachineRunInput, PolicyInput, RunInput, Cafe24ManualPreparationInput, Cafe24ActivationReviewQuery, Cafe24DayActivationInput } from "./daily-sync.dto";
import { SourceConnectionsService, accountAllowlist, accountKey } from "./source-connections.service";
import { SyncFoundationService } from "./sync-foundation.service";
import { assertEnabled, parseDateRange, syncError } from "./sync-contract";
import { GoogleSyncRunnerService } from "./google-sync-runner.service";
import { GoogleConnectionVerifierService } from "./google-connection-verifier.service";
import { MetaSyncRunnerService } from "./meta-sync-runner.service";
import { MetaCredentialBindingService } from "./meta-credential-binding.service";
import { MetaConnectionVerifierService } from "./meta-connection-verifier.service";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { Cafe24OrdersClient } from "./cafe24-orders.client";
import { Cafe24SyncRunnerService } from "./cafe24-sync-runner.service";
import { ScheduledSyncService } from "./scheduled-sync.service";
import {Cafe24ScheduledBootstrapInput} from "./daily-sync.dto";
import {bootstrapCafe24Scheduled,cafe24ScheduledBootstrapPreview} from "./cafe24-scheduled-bootstrap";
import { cafe24ManualActivationPreview, cafe24ManualPreparationPreview, prepareCafe24ManualConnection } from "./cafe24-manual-preparation";

@Controller("source-connections")
export class SourceConnectionsController {
  constructor(private readonly sources: SourceConnectionsService,
    private readonly googleVerifier: GoogleConnectionVerifierService,
    private readonly metaCredential: MetaCredentialBindingService,
    private readonly metaVerifier: MetaConnectionVerifierService,
    private readonly prisma: PrismaService) {}

  @Get(":id/cafe24-preparation")
  @RequirePermissions("settings.manage")
  cafe24PreparationPreview(@Param() params: IdParam) {
    return cafe24ManualPreparationPreview(this.prisma, params.id);
  }

  @Post(":id/prepare-cafe24")
  @RequirePermissions("settings.manage")
  prepareCafe24(@Param() params: IdParam, @Body() body: Cafe24ManualPreparationInput,
    @CurrentUser() actor: AuthenticatedUser) {
    return prepareCafe24ManualConnection(this.prisma, params.id, body, actor.id);
  }

  @Get(":id/cafe24-activation-snapshot")
  @RequirePermissions("settings.manage")
  @HeavyOperation()
  cafe24ActivationSnapshot(@Param() params: IdParam, @Query() query: Cafe24ActivationReviewQuery) {
    return cafe24ManualActivationPreview(this.prisma, params.id, query);
  }

  @Post(":id/activate-cafe24-day")
  @RequirePermissions("settings.manage")
  @HeavyOperation()
  activateCafe24Day(@Param() params: IdParam, @Body() body: Cafe24DayActivationInput,
    @CurrentUser() actor: AuthenticatedUser) {
    if ((body.expectedMappingChangeLines ?? 0) > 0 &&
        !actor.permissions.includes("mappings.manage"))
      throw new ForbiddenException({ code: "PERMISSION_DENIED" });
    return this.sources.activateCafe24Day(params.id, body, actor.id);
  }

  @Get(":id/cafe24-scheduled-bootstrap")
  @RequirePermissions("settings.manage")
  cafe24BootstrapPreview(@Param() params:IdParam) {return cafe24ScheduledBootstrapPreview(this.prisma,params.id);}

  @Post(":id/cafe24-scheduled-bootstrap")
  @RequirePermissions("settings.manage")
  cafe24Bootstrap(@Param() params:IdParam,@Body() body:Cafe24ScheduledBootstrapInput,@CurrentUser() actor:AuthenticatedUser) {
    return bootstrapCafe24Scheduled(this.prisma,params.id,body,actor.id);
  }

  @Post()
  @RequirePermissions("settings.manage")
  create(@Body() body: ConnectionInput, @CurrentUser() actor: AuthenticatedUser) {
    return this.sources.create(body, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query() query: ConnectionListQuery) { return this.sources.list(query.limit ?? 50, query.page ?? 1); }

  @Patch(":id/policy")
  @RequirePermissions("settings.manage")
  policy(@Param() params: IdParam, @Body() body: PolicyInput, @CurrentUser() actor: AuthenticatedUser) {
    return this.sources.setPolicy(params.id, body, actor.id);
  }

  @Post(":id/verify-google")
  @RequirePermissions("settings.manage")
  verifyGoogle(@Param() params: IdParam, @Body() body: GoogleVerificationInput,
    @CurrentUser() actor: AuthenticatedUser) {
    return this.googleVerifier.verifyAndActivate({ connectionId: params.id,
      verificationDay: body.verificationDay, observedAccountCostKrw: body.observedAccountCostKrw,
      fromDate: body.fromDate, actorUserId: actor.id });
  }

  @Post(":id/bind-google-auth")
  @RequirePermissions("settings.manage")
  bindGoogleAuth(@Param() params: IdParam, @CurrentUser() actor: AuthenticatedUser) {
    return this.googleVerifier.bindConfiguredAuth(params.id, actor.id);
  }

  @Post(":id/bind-meta-auth")
  @RequirePermissions("settings.manage")
  bindMetaAuth(@Param() params: IdParam, @CurrentUser() actor: AuthenticatedUser) {
    return this.metaCredential.bindConfiguredAuth(params.id, actor.id);
  }
  @Post(":id/verify-meta")
  @RequirePermissions("settings.manage")
  @HeavyOperation()
  verifyMeta(@Param() params: IdParam, @Body() body: MetaVerificationInput, @CurrentUser() actor: AuthenticatedUser) {
    return this.metaVerifier.verifyAndActivate({ connectionId: params.id, ...body, actorUserId: actor.id });
  }
}

@Controller("sync-runs")
export class SyncRunsController {
  constructor(private readonly sync: SyncFoundationService, private readonly prisma: PrismaService,
    private readonly google: GoogleSyncRunnerService,
    private readonly cafe24: Cafe24SyncRunnerService,
    private readonly meta: MetaSyncRunnerService) {}

  @Post()
  @RequirePermissions("imports.manage")
  @HttpCode(HttpStatus.ACCEPTED)
  queue(@Body() body: RunInput, @CurrentUser() actor: AuthenticatedUser) {
    return this.sync.queueRun({ connectionId: body.connectionId,
      fromDate: body.fromDate, toDate: body.toDate, trigger: body.mode as SyncTrigger,
      requestKey: body.requestKey, actorUserId: actor.id, reason: body.reason });
  }

  @Get(":id")
  @RequirePermissions("data.read")
  async get(@Param() params: IdParam) {
    assertEnabled();
    const run = await this.prisma.syncRun.findUnique({ where: { id: params.id },
      include: { units: { orderBy: { unitKey: "asc" }, take: 31 } } });
    if (!run) syncError("ACCOUNT_SCOPE_MISMATCH", 400);
    return run;
  }

  @Post(":id/resume")
  @RequirePermissions("imports.manage")
  @HttpCode(HttpStatus.ACCEPTED)
  resume(@Param() params: IdParam, @CurrentUser() actor: AuthenticatedUser) {
    return this.sync.resumeStale(params.id, actor.id);
  }

  @Post(":id/execute-google")
  @RequirePermissions("imports.manage")
  @HttpCode(HttpStatus.OK)
  executeGoogle(@Param() params: IdParam) { return this.google.execute(params.id); }

  @Post(":id/execute-cafe24")
  @RequirePermissions("imports.manage")
  @HttpCode(HttpStatus.OK)
  executeCafe24(@Param() params: IdParam) { return this.cafe24.execute(params.id); }

  @Post(":id/execute-meta")
  @RequirePermissions("imports.manage")
  @HttpCode(HttpStatus.OK)
  executeMeta(@Param() params: IdParam) { return this.meta.execute(params.id); }
}

@Controller("source-coverage")
export class SourceCoverageController {
  constructor(private readonly prisma: PrismaService, private readonly scheduled: ScheduledSyncService) {}

  @Get("schedule-warnings")
  @RequirePermissions("data.read")
  scheduleWarnings() { return this.scheduled.warnings(); }

  @Get()
  @RequirePermissions("data.read")
  async list(@Query() query: CoverageQuery) {
    assertEnabled();
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: query.connectionId } });
    if (!connection) syncError("ACCOUNT_SCOPE_MISMATCH", 400);
    const { from, to } = parseDateRange(query.from, query.to, new Date(), connection.timeZone);
    const limit = query.limit ?? 50;
    const page = query.page ?? 1;
    const rows = await this.prisma.sourceCoverage.findMany({
      where: { connectionId: query.connectionId, metricDate: { gte: from, lte: to } },
      orderBy: [{ metricDate: "desc" }, { dataKind: "asc" }],
      skip: (page - 1) * limit, take: limit + 1
    });
    return { items: rows.slice(0, limit).map((row) => {
      const { totalAmount, ...rest } = row;
      return { ...rest, amount: { value: totalAmount?.toString() ?? null,
        currency: connection.currencyCode } };
    }),
      nextPage: rows.length > limit ? page + 1 : null };
  }
}

@Controller("internal")
export class DailySyncMachineController {
  constructor(private readonly scheduled: ScheduledSyncService) {}

  @Post("daily-sync")
  @MachineSync()
  @HttpCode(HttpStatus.OK)
  async enqueue(@Body() body: MachineRunInput, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return this.scheduled.step(body);
  }

  @Post("daily-sync/status")
  @MachineSync()
  @HttpCode(HttpStatus.OK)
  status(@Body() body: MachineRunInput, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return this.scheduled.status(body);
  }
}

@Controller("cafe24")
export class Cafe24ConnectionController {
  constructor(private readonly sources: SourceConnectionsService,
    private readonly oauth: Cafe24OauthService,
    private readonly orders: Cafe24OrdersClient) {}

  @Post("connections/test")
  @RequirePermissions("settings.manage")
  createTest(@CurrentUser() actor: AuthenticatedUser) {
    return this.sources.createCafe24Test(actor.id);
  }

  @Post("connections/:id/authorize")
  @RequirePermissions("settings.manage")
  begin(@Param() params: IdParam, @CurrentUser() actor: AuthenticatedUser) {
    return this.oauth.begin(params.id, actor.id);
  }

  @Get("connections/:id/orders/summary")
  @RequirePermissions("data.read")
  summary(@Param() params: IdParam, @Query("day") day: string) {
    return this.orders.readDaySummary(params.id, day);
  }

  @Get("connections/:id/orders/probe")
  @RequirePermissions("data.read")
  probe(@Param() params: IdParam, @Query("day") day: string) {
    return this.orders.probeDayShape(params.id, day);
  }

  @Get("connections/:id/orders/statuses")
  @RequirePermissions("data.read")
  statuses(@Param() params: IdParam, @Query("day") day: string) {
    return this.orders.probeDayStatuses(params.id, day);
  }

}

@Controller("integrations/cafe24/oauth")
export class Cafe24OauthCallbackController {
  constructor(private readonly oauth: Cafe24OauthService) {}

  @Get("callback")
  @Public()
  async callback(@Query() query: { state?: string; code?: string; error?: string },
    @Res() response: Response) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      await this.oauth.callback(query);
      response.redirect(303, "/backend-api/integrations/cafe24/oauth/complete");
    } catch {
      response.redirect(303, "/backend-api/integrations/cafe24/oauth/failed");
    }
  }

  @Get("complete")
  @Public()
  complete(@Res() response: Response) {
    response.setHeader("Cache-Control", "no-store");
    response.type("text/plain").send("Cafe24 connection completed. Return to the application.");
  }

  @Get("failed")
  @Public()
  failed(@Res() response: Response) {
    response.setHeader("Cache-Control", "no-store");
    response.status(400).type("text/plain").send("Cafe24 connection failed. Start a new authorization attempt.");
  }
}
