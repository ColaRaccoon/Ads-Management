import { Controller, Get, Query, Res, UsePipes, ValidationPipe } from "@nestjs/common";
import { Response } from "express";
import { RequirePermissions } from "../auth/route-decorators";
import { ListSecurityAuditDto } from "./dto/list-security-audit.dto";
import { SecurityAuditService } from "./security-audit.service";

@Controller("security-audit")
export class SecurityAuditController {
  constructor(private readonly audit: SecurityAuditService) {}

  @Get()
  @RequirePermissions("audit.read")
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  list(@Query() query: ListSecurityAuditDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.audit.list(query);
  }
}
