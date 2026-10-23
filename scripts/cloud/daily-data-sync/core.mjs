import {isOctober16Occurrence} from './october16-profile.mjs';
import {isOctober16RepeatOccurrence} from './october16-repeat-profile.mjs';
export const STAGING_REF = 'ehnfrrmbkvlsbpvqcvkr';
import {assertReviewedDeployment,ISOLATED_IDENTITY} from './deployment-evidence.mjs';
import {isExtraTestOccurrence} from './accelerated-october15-profile.mjs';
export const STAGING_ORIGIN = ISOLATED_IDENTITY.origin;
export function assertStagingDeployment(evidence) {return assertReviewedDeployment(evidence);}
export const PREFIX = 'daily-data-sync-08-';
const statuses = new Set(['NOT_STARTED', 'QUEUED', 'RUNNING', 'PARTIAL', 'FAILED', 'ACTION_REQUIRED', 'CANCELLED', 'SUCCEEDED', 'DELAYED', 'EXPIRED']);

export function assertTarget(urlText) {
  const url = new URL(urlText);
  const direct = url.hostname === `db.${STAGING_REF}.supabase.co` && url.username === 'postgres';
  const pool = url.hostname==='aws-0-ap-northeast-2.pooler.supabase.com' && url.username === `postgres.${STAGING_REF}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pool) ||
      (url.port && url.port !== '5432') || url.pathname !== '/postgres' ||
      url.searchParams.get('sslmode') !== 'verify-full' || url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length !== 1) throw new Error('STAGING_TARGET_REJECTED');
  return url;
}

export function assertSchedule(config) {
  if (!config || !/^[a-z][a-z0-9-]{2,47}$/.test(config.key) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.connectionId) ||
      !['CAFE24', 'GOOGLE', 'META'].includes(config.provider) || config.timeZone !== 'Asia/Seoul' ||
      !Number.isInteger(config.windowMinutes) || config.windowMinutes < (config.provider === 'CAFE24' ? 60 : 35) || config.windowMinutes > 120 ||
      !Number.isFinite(Date.parse(config.anchorAt)) || new Date(config.anchorAt).toISOString() !== config.anchorAt) throw new Error('INVALID_SCHEDULE');
  const anchor = new Date(config.anchorAt);
  const approvedTest = [
    ['phase08-cafe24','0c35defe-45fc-4a54-bc79-704df7bca5b1','CAFE24','2026-10-15T01:00:00.000Z'],
    ['phase08-google','b9ebee4b-5d4e-4eae-92b9-9facfbf3c900','GOOGLE','2026-10-15T01:01:00.000Z'],
    ['phase08-meta','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6','META','2026-10-15T01:02:00.000Z']
  ].some(([key,id,provider,at])=>config.key===key&&config.connectionId===id&&config.provider===provider&&config.anchorAt===at&&config.windowMinutes===(provider==='CAFE24'?110:90));
  if (!approvedTest && !(isExtraTestOccurrence(config)||isOctober16Occurrence(config)||isOctober16RepeatOccurrence(config)) && (anchor.getUTCSeconds() || anchor.getUTCMilliseconds() ||
      (config.provider === 'CAFE24' && (anchor.getUTCHours() !== 17 || anchor.getUTCMinutes() !== 0)) ||
      anchor.getUTCHours() < 17 || anchor.getUTCHours() > 18 ||
      anchor.getUTCHours() * 60 + anchor.getUTCMinutes() + config.windowMinutes > 19 * 60 - 5)) throw new Error('INVALID_SCHEDULE_WINDOW');
  return { ...config, cadenceDays: config.provider === 'CAFE24' ? 1 : 7 };
}

export function occurrence(config, now) {
  const checked = assertSchedule(config);
  const cadence = checked.cadenceDays * 86_400_000;
  const anchor = Date.parse(checked.anchorAt);
  if (now < anchor) return null;
  if ((isExtraTestOccurrence(checked)||isOctober16Occurrence(checked)||isOctober16RepeatOccurrence(checked))) return {scheduledFor:checked.anchorAt,deadlineAt:new Date(anchor+checked.windowMinutes*60000).toISOString()};
  const due = anchor + Math.floor((now - anchor) / cadence) * cadence;
  return { scheduledFor: new Date(due).toISOString(), deadlineAt: new Date(due + checked.windowMinutes * 60_000).toISOString() };
}

export function assertResponse(body, expected) {
  const lastDay = new Date(Date.parse(expected.scheduledFor) + 9 * 3600_000 - 86400_000).toISOString().slice(0,10);
  const firstDay = new Date(Date.parse(`${lastDay}T00:00:00Z`) - (expected.provider === 'CAFE24' ? 0 : 6) * 86400_000).toISOString().slice(0,10);
  if (!body || body.scheduleKey !== expected.key || body.scheduledFor !== expected.scheduledFor ||
      !statuses.has(body.status) || !Number.isInteger(body.completedUnits) || !Number.isInteger(body.totalUnits) ||
      body.totalUnits !== (expected.provider === 'CAFE24' ? 1 : 7) || body.completedUnits < 0 ||
      body.completedUnits > body.totalUnits || (body.status === 'SUCCEEDED' && body.completedUnits !== body.totalUnits) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(body.toDate) ||
      Date.parse(body.toDate) - Date.parse(body.fromDate) !== (body.totalUnits - 1) * 86_400_000 ||
      body.toDate !== lastDay || body.fromDate !== firstDay) throw new Error('INVALID_APP_RESPONSE');
  return { status: body.status, completedUnits: body.completedUnits, totalUnits: body.totalUnits };
}

export function jobPlan(config) {
  const checked = assertSchedule(config);
  const start = new Date(checked.anchorAt);
  const at = start.getUTCHours() * 60 + start.getUTCMinutes();
  // These jobs touch only management DB when a slot is not due or already successful.
  // Each account owns its jobs; a slow/failing provider cannot prevent Cafe24 dispatch.
  const interval = checked.provider === 'CAFE24' ? 1 : 5;
  const offsets = Array.from({ length: Math.ceil(checked.windowMinutes / interval) }, (_, i) => i * interval);
  const jobs = offsets.map((offset, i) => ({ name: `${PREFIX}${checked.key}-${i}`, cron: `${(at + offset) % 60} ${Math.floor((at + offset) / 60)} * * *`, command: `SELECT daily_data_sync_ops.invoke('${checked.key}')` }));
  // Allow the last application's two-minute lease to expire before reconciliation.
  const audit = at + checked.windowMinutes + 3;
  jobs.push({ name: `${PREFIX}${checked.key}-audit`, cron: `${audit % 60} ${Math.floor(audit / 60)} * * *`, command: `SELECT daily_data_sync_ops.audit('${checked.key}')` });
  return jobs;
}
