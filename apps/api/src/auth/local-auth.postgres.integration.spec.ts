import { randomBytes } from "node:crypto";
import { AppRole, InviteStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AuthConfig } from "./auth.config";
import { AuthCookieService } from "./cookie.service";
import { LocalAuthService } from "./local-auth.service";
import { createCredential, ScryptWorkLimiter } from "./local-credentials";
import { PrismaService } from "../common/prisma.service";
import { LocalUsersService } from "../users/local-users.service";
import { supabaseIntegrationEnabled } from "../common/supabase-integration-target";

const enabled = supabaseIntegrationEnabled("RUN_POSTGRES_INTEGRATION", "DATABASE_URL");
const suite = enabled ? describe : describe.skip;

suite("local Auth on isolated PostgreSQL", () => {
  it("enforces one-time setup, refresh-family revocation, role/inactive changes and password reset", async () => {
    const suffix=randomBytes(8).toString("hex"); const actorUsername=`sa_${suffix}`;const userUsername=`user_${suffix}`;
    const config=integrationConfig();const prisma=new PrismaService();await prisma.$connect();
    const auth=new LocalAuthService(prisma,config,new AuthCookieService(config));const users=new LocalUsersService(prisma,auth,config);
    let actorId:string|undefined;let targetId:string|undefined;
    try{
      const credential=await createCredential(`Actor-${randomBytes(24).toString("base64url")}!`,new ScryptWorkLimiter(1,2));
      const actor=await prisma.appUser.create({data:{username:actorUsername,normalizedUsername:actorUsername,name:"Integration super admin",role:AppRole.SUPER_ADMIN,inviteStatus:InviteStatus.ACTIVE,localCredential:{create:credential}}});actorId=actor.id;
      const invited=await users.invite({username:userUsername,name:"Integration user",role:AppRole.USER},actor.id);targetId=invited.id;
      expect(invited.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const attempts=await Promise.allSettled([auth.acceptSetupToken(invited.setupToken!),auth.acceptSetupToken(invited.setupToken!)]);
      expect(attempts.filter((item)=>item.status==="fulfilled")).toHaveLength(1);expect(attempts.filter((item)=>item.status==="rejected")).toHaveLength(1);
      const accepted=(attempts.find((item)=>item.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof auth.acceptSetupToken>>>).value;
      const onboarding=await auth.authenticateSession(accepted.sessionToken);const password=`User-${randomBytes(24).toString("base64url")}!`;
      const completed=await auth.completeInitialPassword(onboarding,password);await expect(auth.login(userUsername,password)).resolves.toBeDefined();
      const loggedIn=await auth.login(userUsername,password);const rotations=await Promise.allSettled([auth.refresh(loggedIn.sessionToken),auth.refresh(loggedIn.sessionToken)]);
      expect(rotations.filter((item)=>item.status==="fulfilled")).toHaveLength(1);const rotated=(rotations.find((item)=>item.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof auth.refresh>>>).value;
      await auth.logout(loggedIn.sessionToken);await expect(auth.authenticateSession(rotated.sessionToken)).rejects.toThrow();
      const roleSession=await auth.login(userUsername,password);await users.update(invited.id,{role:AppRole.GUEST},actor.id);await expect(auth.authenticateSession(roleSession.sessionToken)).rejects.toThrow();
      const guestSession=await auth.login(userUsername,password);await expect(auth.authenticateSession(guestSession.sessionToken)).resolves.toMatchObject({role:AppRole.GUEST});
      await users.update(invited.id,{isActive:false},actor.id);await expect(auth.authenticateSession(guestSession.sessionToken)).rejects.toThrow();
      await users.update(invited.id,{isActive:true},actor.id);const resetSession=await auth.login(userUsername,password);const reset=await users.resetPassword(invited.id,actor.id);expect(reset.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);await expect(auth.authenticateSession(resetSession.sessionToken)).rejects.toThrow();
      const tokenRows=await prisma.localAccountSetupToken.findMany({where:{appUserId:invited.id},select:{tokenHash:true}});expect(tokenRows.every((row)=>row.tokenHash!==invited.setupToken&&row.tokenHash!==reset.setupToken)).toBe(true);
      const audits=await prisma.securityAuditEvent.findMany({where:{OR:[{actorUserId:actorId},{targetId}]},select:{action:true,beforeJson:true,afterJson:true}});expect(audits.length).toBeGreaterThan(0);expect(JSON.stringify(audits)).not.toContain(invited.setupToken);expect(JSON.stringify(audits)).not.toContain(reset.setupToken);
      expect(completed.response.user.inviteStatus).toBe(InviteStatus.ACTIVE);
    }finally{
      if(targetId||actorId){const ids=[targetId,actorId].filter((id):id is string=>Boolean(id));await prisma.$transaction(async(tx)=>{const deactivatedAt=new Date();await tx.appAuthSession.updateMany({where:{appUserId:{in:ids},revokedAt:null},data:{revokedAt:deactivatedAt}});await tx.localAccountSetupToken.updateMany({where:{appUserId:{in:ids},usedAt:null,revokedAt:null},data:{revokedAt:deactivatedAt}});await tx.appUser.updateMany({where:{id:{in:ids},isActive:true},data:{isActive:false,deactivatedAt}});});await expect(prisma.localAccountSetupToken.count({where:{appUserId:{in:ids},usedAt:null,revokedAt:null}})).resolves.toBe(0);}
      await prisma.$disconnect();
    }
  },120_000);
});

function integrationConfig():AuthConfig{
  const secret=()=>randomBytes(48).toString("base64url");
  return{provider:"local",supabaseUrl:"",supabasePublishableKey:"",supabaseSecretKey:"",jwtIssuer:"",jwtAudience:"",cookieSecure:true,cookieNamespace:"integration",sessionHandleSecret:secret(),authorizationVersionSecret:secret(),csrfSecret:secret(),csrfTtlMs:3600000,allowedOrigins:new Set(["https://integration.invalid"]),inviteRedirectOrigin:"",production:true,localSessionTokenSecret:secret(),localSetupTokenSecret:secret(),localRateLimitSecret:secret(),localSessionIdleTtlMs:3600000,localSessionAbsoluteTtlMs:86400000,localSessionRotationTtlMs:60000,localSetupTokenTtlMs:3600000,localScryptConcurrency:2,localScryptQueueLimit:8};
}
