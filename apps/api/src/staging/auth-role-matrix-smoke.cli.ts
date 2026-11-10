import "reflect-metadata";
import { Controller, ExecutionContext, Module, RequestMethod, Type } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { AppRole } from "@prisma/client";
import { AUTH_CONFIG } from "../auth/auth.config";
import { authError } from "../auth/auth.errors";
import { AuthenticationGuard } from "../auth/authentication.guard";
import { AuthService } from "../auth/auth.service";
import { AuthCookieService } from "../auth/cookie.service";
import { LocalAuthService } from "../auth/local-auth.service";
import { PermissionGuard } from "../auth/permission.guard";
import { PERMISSIONS, permissionsForRole } from "../auth/role-permissions";
import { REQUIRED_PERMISSIONS } from "../auth/route-decorators";
import { AuthRequestSecurityService } from "../auth/request-security.service";
import { ChangeLogsController } from "../change-logs/change-logs.controller";
import { ChangeLogsService } from "../change-logs/change-logs.service";
import { CoupangController } from "../coupang/coupang.controller";
import { DecisionsController } from "../decisions/decisions.controller";
import { DecisionsService } from "../decisions/decisions.service";
import { DashboardController } from "../metrics/dashboard.controller";
import { MetricsController } from "../metrics/metrics.controller";
import { MappingsController } from "../mappings/mappings.controller";
import { MappingsService } from "../mappings/mappings.service";
import { ProductRulesController } from "../products/product-rules.controller";
import { ProductsController } from "../products/products.controller";
import { ProductsService } from "../products/products.service";
import { SettingsController } from "../products/settings.controller";
import { ReportsController } from "../reports/reports.controller";
import { ReportsService } from "../reports/reports.service";
import { InfluencerController } from "../influencers/influencer.controller";
import { InfluencerRecordsService } from "../influencers/influencer-records.service";
import { SecurityAuditController } from "../security-audit/security-audit.controller";
import { SecurityAuditService } from "../security-audit/security-audit.service";
import { Cafe24CouponRulesController } from "../sales/cafe24-coupon-rules.controller";
import { Cafe24UploadsController } from "../sales/cafe24-uploads.controller";
import { SalesMetricsController } from "../sales/sales-metrics.controller";
import { UploadsController } from "../uploads/uploads.controller";
import { UploadsService } from "../uploads/uploads.service";
import { UsersController } from "../users/users.controller";
import { LocalUsersService } from "../users/local-users.service";
import { UsersService } from "../users/users.service";

const serviceCalls: string[] = [];
const serviceMock = new Proxy({}, { get: (_target, property) => property === "then" ? undefined : (...args: unknown[]) => {
  serviceCalls.push(`${String(property)}:${args.length}`);
  return Promise.resolve({ items: [] });
} });

@Controller()
class EmptyController {}

@Module({
  controllers: [EmptyController, UploadsController, ReportsController, ProductsController, MappingsController, DecisionsController, ChangeLogsController, UsersController, SecurityAuditController, InfluencerController],
  providers: [
    { provide: UploadsService, useValue: serviceMock }, { provide: ReportsService, useValue: serviceMock },
    { provide: ProductsService, useValue: serviceMock }, { provide: MappingsService, useValue: serviceMock },
    { provide: DecisionsService, useValue: serviceMock }, { provide: ChangeLogsService, useValue: serviceMock },
    { provide: UsersService, useValue: serviceMock }, { provide: LocalUsersService, useValue: serviceMock },
    { provide: InfluencerRecordsService, useValue: serviceMock },
    { provide: SecurityAuditService, useValue: serviceMock }, { provide: AUTH_CONFIG, useValue: { provider: "local" } },
    { provide: AuthRequestSecurityService, useValue: { assertCsrfMutation: async () => undefined } },
    { provide: AuthService, useValue: {} },
    { provide: AuthCookieService, useValue: { readSessionHandle: (request: { headers: Record<string,string | string[] | undefined> }) => {
      const value=request.headers["x-compatibility-role"];return Array.isArray(value)?value[0]:value;
    } } },
    { provide: LocalAuthService, useValue: { authenticateSession: async (token: string) => {
      if(token==="INACTIVE")throw authError("ACCOUNT_INACTIVE");
      if(token==="SETUP_PENDING")throw authError("ACCOUNT_ONBOARDING_REQUIRED");
      if(!Object.values(AppRole).includes(token as AppRole))throw authError("AUTHENTICATION_REQUIRED");
      return { id: `compat-${token.toLowerCase()}`, role: token, permissions: permissionsForRole(token as AppRole) };
    } } },
    { provide: AuthenticationGuard, useFactory: (auth: AuthService,cookies: AuthCookieService,reflector: Reflector,local: LocalAuthService) => new AuthenticationGuard(auth,cookies,reflector,{provider:"local"} as never,local), inject:[AuthService,AuthCookieService,Reflector,LocalAuthService] },
    { provide: PermissionGuard, useFactory: (reflector: Reflector) => new PermissionGuard(reflector), inject:[Reflector] },
    { provide: APP_GUARD, useExisting: AuthenticationGuard }, { provide: APP_GUARD, useExisting: PermissionGuard }
  ]
})
class MatrixModule {}

const routes = [
  { method:"GET", path:"/uploads", allowed:["GUEST","USER","ADMIN","SUPER_ADMIN"] },
  { method:"POST", path:"/change-logs", allowed:["USER","ADMIN","SUPER_ADMIN"], body:{} },
  { method:"POST", path:"/reports/export", allowed:["USER","ADMIN","SUPER_ADMIN"], body:{reportType:"PERIOD_XLSX",from:"2026-01-01",to:"2026-01-01"} },
  { method:"POST", path:"/products", allowed:["ADMIN","SUPER_ADMIN"], body:{} },
  { method:"DELETE", path:"/uploads/11111111-1111-4111-8111-111111111111", allowed:["ADMIN","SUPER_ADMIN"] },
  { method:"POST", path:"/mappings/product-rules", allowed:["ADMIN","SUPER_ADMIN"], body:{} },
  { method:"POST", path:"/decisions/run", allowed:["ADMIN","SUPER_ADMIN"], body:{} },
  { method:"POST", path:"/uploads/storage-tombstones/11111111-1111-4111-8111-111111111111/restore", allowed:["SUPER_ADMIN"] },
  { method:"GET", path:"/users", allowed:["SUPER_ADMIN"] },
  { method:"GET", path:"/security-audit", allowed:["SUPER_ADMIN"] }
] as const;

const influencerHttpRoutes = [
  { method:"GET", path:"/storefront/influencers", allowed:["GUEST","USER","ADMIN","SUPER_ADMIN"] },
  { method:"GET", path:"/storefront/influencers/11111111-1111-4111-8111-111111111111/creatives", allowed:["GUEST","USER","ADMIN","SUPER_ADMIN"] },
  { method:"POST", path:"/storefront/influencers", allowed:["USER","ADMIN","SUPER_ADMIN"], body:{} },
  { method:"PATCH", path:"/storefront/influencers/11111111-1111-4111-8111-111111111111", allowed:["USER","ADMIN","SUPER_ADMIN"], body:{} },
  { method:"DELETE", path:"/storefront/influencers/11111111-1111-4111-8111-111111111111?version=22222222-2222-4222-8222-222222222222", allowed:["USER","ADMIN","SUPER_ADMIN"] },
  { method:"GET", path:"/storefront/influencers/daily", allowed:["GUEST","USER","ADMIN","SUPER_ADMIN"] },
  { method:"PATCH", path:"/storefront/influencers/11111111-1111-4111-8111-111111111111/numbering", allowed:["ADMIN","SUPER_ADMIN"], body:{} }
] as const;

const permissionControllers: readonly Type<unknown>[] = [
  UploadsController, ProductsController, ProductRulesController, SettingsController, MappingsController,
  DashboardController, MetricsController, DecisionsController, ReportsController, ChangeLogsController,
  SalesMetricsController, Cafe24UploadsController, Cafe24CouponRulesController, CoupangController,
  UsersController, SecurityAuditController, InfluencerController
];

// These routes postdate the original Windows rollback contract. Verify all of
// them in the full matrix and compare the original matrix across releases.
const additiveRoutes = new Map([
  ["GET /api/dashboard/meta-collection", "data.read"],
  ["PATCH /api/mappings/product-rules/:id", "mappings.manage"],
  ["POST /api/mappings/product-rules/:id/apply", "mappings.manage"],
  ["GET /api/storefront/influencers", "data.read"],
  ["GET /api/storefront/influencers/:id/creatives", "data.read"],
  ["POST /api/storefront/influencers", "influencers.manage"],
  ["PATCH /api/storefront/influencers/:id", "influencers.manage"],
  ["DELETE /api/storefront/influencers/:id", "influencers.manage"],
  ["GET /api/storefront/influencers/daily", "data.read"],
  ["PATCH /api/storefront/influencers/:id/numbering", "influencers.numbering"]
]);

function digestOf(lines: readonly string[]) {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function matrixProof(inventory: readonly string[], guards: readonly string[], http: readonly string[]) {
  const routeInventoryDigest = digestOf(inventory);
  const fullMatrixDigest = digestOf(guards);
  const httpMatrixDigest = digestOf(http);
  return { routeInventoryDigest, fullMatrixDigest, httpMatrixDigest,
    digest: digestOf([routeInventoryDigest, fullMatrixDigest, httpMatrixDigest]) };
}

function normalizedPath(...parts: unknown[]) {
  return `/${parts.map((part) => String(part ?? "").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
}

function activePermissionRoutes() {
  const result: Array<{ method: string; path: string; permission: string; handler: Function; controller: Type<unknown> }> = [];
  for (const controller of permissionControllers) {
    const controllerPath=Reflect.getMetadata(PATH_METADATA,controller)??"";
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if(name==="constructor")continue;
      const handler=controller.prototype[name];const method=Reflect.getMetadata(METHOD_METADATA,handler) as RequestMethod|undefined;
      const handlerPath=Reflect.getMetadata(PATH_METADATA,handler);const required=Reflect.getMetadata(REQUIRED_PERMISSIONS,handler) as string[]|undefined;
      if(method===undefined||handlerPath===undefined||required?.length!==1)continue;
      result.push({method:RequestMethod[method],path:normalizedPath("api",controllerPath,handlerPath),permission:required[0],handler,controller});
    }
  }
  return result.sort((a,b)=>`${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function guardContext(handler: Function, controller: Type<unknown>, request: Record<string,unknown>) {
  return {getHandler:()=>handler,getClass:()=>controller,switchToHttp:()=>({getRequest:()=>request})} as unknown as ExecutionContext;
}

function statusOf(error: unknown){return typeof (error as {getStatus?:unknown})?.getStatus==="function"?(error as {getStatus:()=>number}).getStatus():500}

async function run(){
  const releaseId=process.env.LOCAL_RELEASE_ID?.trim();if(!releaseId||!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId))throw new Error("ROLE_MATRIX_RELEASE_ID_INVALID");
  const inventory=activePermissionRoutes();
  const inventoryPermissions=new Set(inventory.map(route=>route.permission));
  const original = inventory.filter(route => !additiveRoutes.has(`${route.method} ${route.path}`));
  const additions = inventory.filter(route => additiveRoutes.has(`${route.method} ${route.path}`));
  if (original.length !== 121 || new Set(original.map(route => route.permission)).size !== 10 ||
      additions.length !== additiveRoutes.size ||
      new Set(additions.map(route => `${route.method} ${route.path}`)).size !== additiveRoutes.size ||
      additions.some(route => additiveRoutes.get(`${route.method} ${route.path}`) !== route.permission) ||
      inventoryPermissions.size !== PERMISSIONS.length || PERMISSIONS.some(permission => !inventoryPermissions.has(permission))) {
    throw new Error("ROLE_MATRIX_ACTIVE_ROUTE_INVENTORY_INVALID");
  }
  const inventoryLine = (route: (typeof inventory)[number]) => `${route.method}|${route.path}|${route.permission}`;
  const reflector=new Reflector();
  const directCookies={readSessionHandle:(request:{headers?:Record<string,string>})=>request.headers?.["x-compatibility-role"]};
  const directLocal={authenticateSession:async(token:string)=>{if(token==="INACTIVE")throw authError("ACCOUNT_INACTIVE");if(token==="SETUP_PENDING")throw authError("ACCOUNT_ONBOARDING_REQUIRED");if(!Object.values(AppRole).includes(token as AppRole))throw authError("AUTHENTICATION_REQUIRED");return{id:`compat-${token.toLowerCase()}`,role:token,permissions:permissionsForRole(token as AppRole)}}};
  const directAuthentication=new AuthenticationGuard({} as never,directCookies as never,reflector,{provider:"local"} as never,directLocal as never);const directPermission=new PermissionGuard(reflector);
  const fullMatrix:string[]=[];const originalMatrix:string[]=[];
  let blockedHandlerInvocations=0;let originalBlocked=0;
  for(const role of ["ANONYMOUS","INACTIVE","SETUP_PENDING","GUEST","USER","ADMIN","SUPER_ADMIN"]){
    for(const route of inventory){const request:Record<string,unknown>={headers:role==="ANONYMOUS"?{}:{"x-compatibility-role":role}};const context=guardContext(route.handler,route.controller,request);let status=200;try{await directAuthentication.canActivate(context);directPermission.canActivate(context)}catch(error){status=statusOf(error)}const expected=Object.values(AppRole).includes(role as AppRole)&&permissionsForRole(role as AppRole).includes(route.permission as never);if((status===200)!==expected||(!expected&&status!==401&&status!==403))throw new Error("ROLE_MATRIX_COMPLETE_GUARD_MISMATCH");
      const line = `${role}|${route.method}|${route.path}|${status}`;
      fullMatrix.push(line);
      if (!expected) blockedHandlerInvocations += 1;
      if (!additiveRoutes.has(`${route.method} ${route.path}`)) {
        originalMatrix.push(line);
        if (!expected) originalBlocked += 1;
      }
    }
  }
  const app=await NestFactory.create(MatrixModule,{logger:false,abortOnError:false});await app.listen(0,"127.0.0.1");
  try{
    const address=app.getHttpServer().address() as AddressInfo;const base=`http://127.0.0.1:${address.port}`;const matrix: string[]=[];const originalHttp: string[]=[];
    for(const role of ["ANONYMOUS","INACTIVE","SETUP_PENDING","GUEST","USER","ADMIN","SUPER_ADMIN"]){
      for(const [index, route] of [...routes, ...influencerHttpRoutes].entries()){const before=serviceCalls.length;const response=await fetch(`${base}${route.path}`,{method:route.method,headers:{...(role==="ANONYMOUS"?{}:{"x-compatibility-role":role}),"content-type":"application/json"},body:"body" in route?JSON.stringify(route.body):undefined});const expected=route.allowed.includes(role as never);if(expected!==response.ok)throw new Error("ROLE_MATRIX_HTTP_RESULT_MISMATCH");if(!expected&&serviceCalls.length!==before)throw new Error("ROLE_MATRIX_DENIED_HANDLER_INVOKED");if(expected&&serviceCalls.length===before)throw new Error("ROLE_MATRIX_ALLOWED_HANDLER_NOT_INVOKED");
        const line = `${role}|${route.method}|${route.path}|${response.status}`;
        matrix.push(line);
        if (index < routes.length) originalHttp.push(line);
        await response.arrayBuffer();
      }
    }
    const proof = matrixProof(inventory.map(inventoryLine), fullMatrix, matrix);
    const compatibility = matrixProof(original.map(inventoryLine), originalMatrix, originalHttp);
    process.stdout.write(`${JSON.stringify({
      event:"auth-role-matrix-smoke", releaseId, contractVersion:5, ...proof, roles:7, routes:inventory.length,
      httpRoutes:routes.length+influencerHttpRoutes.length, permissionClasses:inventoryPermissions.size,
      blockedHandlerInvocations, deniedServiceInvocations:0,
      compatibility:{ ...compatibility, routes:original.length, httpRoutes:routes.length,
        permissionClasses:new Set(original.map(route=>route.permission)).size, blockedHandlerInvocations:originalBlocked }
    })}\n`);
  }finally{await app.close()}
}
void run().catch(()=>{process.stderr.write('{"event":"auth-role-matrix-smoke","result":"FAIL"}\n');process.exitCode=1});
