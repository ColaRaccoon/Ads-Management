import {CAFE24_ACTIVATION_GUARDS,Cafe24ActivationRejected} from "./cafe24-activation-diagnostic";
import { SAFE_SYNC_CODES, safeSyncCode } from "./sync-contract";
import {Cafe24MappingReviewChanged,Cafe24MappingReviewEvidence,validateMappingReviewEvidence} from "./cafe24-live-mapping-review-error";

export const LIVE_CHILD_STAGES=["CHILD_INPUT","CHILD_DATABASE","CHILD_SEED_CONFIGURATION","CHILD_SEED_POLICY",
  "CHILD_SEED_CSV","CHILD_PUBLISH","CHILD_ACTIVATE","CHILD_AUTH","CHILD_RESULT_READ","CHILD_RESULT_CALCULATION",
  "CHILD_PROCESS","PARENT_INPUT","PARENT_CONNECTION","PARENT_ENABLE","PARENT_RESTORE","PARENT_OPTION_CAPACITY"] as const;
export const LIVE_CHILD_GUARDS=[...CAFE24_ACTIVATION_GUARDS,"CONFIGURATION_REQUIRED","CONFIGURATION_INVALID","CONFIGURATION_INVENTORY_MISMATCH",
  "CONFIGURATION_FINGERPRINT_MISMATCH","CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED",
  "CANONICAL_CSV_INPUT_INVALID","CANONICAL_CSV_SCOPE_MISMATCH","ISOLATED_CSV_API_IDENTITY_MISMATCH",
  "ISOLATED_CONNECTION_MISMATCH","ISOLATED_CREDENTIAL_OWNER_MISMATCH","ISOLATED_SCHEMA_INVENTORY_MISMATCH",
  "ISOLATED_SUCCESS_REQUIRED","ISOLATED_SUCCESS_NOT_PRESERVED","CONFIGURATION_DATE_REPAIR_ACK_REQUIRED",
  "CONFIGURATION_DATE_REPAIR_SOURCE_INVALID","CONFIGURATION_DATE_REPAIR_TARGET_INVALID","CONFIGURATION_DATE_REPAIR_STATE_CHANGED",
  "CONFIGURATION_DATE_REPAIR_LEGACY_MISMATCH","CONFIGURATION_DATE_REPAIR_NONDATE_CHANGED","CONFIGURATION_DATE_REPAIR_PRESERVATION_FAILED",
  "CONFIGURATION_DATE_REPAIR_EXPECTED_COUNTS_MISMATCH","CONFIGURATION_DATE_REPAIR_POSTCHECK_FAILED",
  "CONFIGURATION_MAPPING_REVIEW_SCOPE_INVALID","CONFIGURATION_MAPPING_UNDATED_CHANGE_REVIEW_REQUIRED","CONFIGURATION_MAPPING_REVIEW_PRESERVATION_FAILED","CONFIGURATION_MAPPING_REVIEW_METADATA_CHANGED","CONFIGURATION_MAPPING_REVIEW_METADATA_INVALID",
  "ISOLATED_REVIEWED_INPUT_EVIDENCE_REQUIRED","ISOLATED_REVIEWED_INPUT_EVIDENCE_CHANGED",
  "ISOLATED_REVIEWED_PROJECTION_REQUIRED","ISOLATED_CHILD_INPUT_INVALID","ISOLATED_CHILD_INPUT_LIMIT",
  "ISOLATED_CHILD_CONNECTION_NOT_READY","ISOLATED_CHILD_CONNECTION_CHANGED","ISOLATED_CHILD_CONNECTION_MISSING","ISOLATED_CHILD_DISABLE_NOT_CONFIRMED",
  "ISOLATED_OPTION_CAPACITY_SHAPE_MISMATCH","ISOLATED_OPTION_CAPACITY_INVENTORY_MISMATCH","ISOLATED_OPTION_CAPACITY_SCOPE_MISMATCH","ISOLATED_OPTION_CAPACITY_ACK_REQUIRED","ISOLATED_OPTION_CAPACITY_SCHEMA_CHANGED","ISOLATED_OPTION_CAPACITY_PRESERVATION_FAILED",
  "CHILD_TIMEOUT","CHILD_SPAWN_FAILED","CHILD_STDIN_FAILED","CHILD_OUTPUT_LIMIT","CHILD_OUTPUT_EMPTY","CHILD_OUTPUT_INVALID_JSON","CHILD_OUTPUT_INVALID_FAILURE","CHILD_OUTPUT_INVALID_RESULT"] as const;
const sqlStates=new Set(["42601","42710","42P07","42701","42703","42P01","42804","42883",
  "23503","23514","23505","55P03","57014","25P02","40001","40P01"]);
export type Cafe24LiveChildDiagnostic={category:typeof LIVE_CHILD_STAGES[number];guard:string|null;sqlState:string|null;statementIndex:null};
export function liveChildFailure(error:unknown,category:typeof LIVE_CHILD_STAGES[number]) {
  const value=error as {message?:unknown;safeCode?:unknown;meta?:{code?:unknown};getResponse?:()=>unknown}|null;
  let response:unknown=null;
  try {if(typeof value?.getResponse==="function")response=value.getResponse();} catch { /* never inspect arbitrary exception text */ }
  const responseCode=response && typeof response==="object" && "code" in response ? response.code : value?.safeCode;
  const activationGuard=category==="CHILD_ACTIVATE" && error instanceof Cafe24ActivationRejected && responseCode==="SOURCE_SELECTION_REQUIRED" && (CAFE24_ACTIVATION_GUARDS as readonly string[]).includes(error.activationGuardCode)?error.activationGuardCode:null;
  return {code:safeSyncCode(responseCode),diagnostic:{category,
    guard:activationGuard??(typeof value?.message==="string" && (LIVE_CHILD_GUARDS as readonly string[]).includes(value.message) && !(CAFE24_ACTIVATION_GUARDS as readonly string[]).includes(value.message)?value.message:null),
    sqlState:typeof value?.meta?.code==="string" && sqlStates.has(value.meta.code)?value.meta.code:null,
    statementIndex:null} satisfies Cafe24LiveChildDiagnostic,
    ...(error instanceof Cafe24MappingReviewChanged ? {mappingReviewEvidence:validateMappingReviewEvidence(error.evidence)} : {})};
}
export class Cafe24LiveChildFailure extends Error {
  constructor(readonly safeCode:string,readonly diagnostic:Cafe24LiveChildDiagnostic,readonly mappingReviewEvidence?:Cafe24MappingReviewEvidence,
    readonly processEvidence?:{exitCode:number|null;signal:string|null}) {super("ISOLATED_CANONICAL_CHILD_FAILED");}
}
const signals=new Set(["SIGTERM","SIGKILL","SIGABRT","SIGSEGV","SIGBUS","SIGINT","SIGHUP"]);
export function processLiveChildFailure(guard:typeof LIVE_CHILD_GUARDS[number],exitCode:unknown,signal:unknown) {
  return new Cafe24LiveChildFailure("PROVIDER_UNAVAILABLE",{category:"CHILD_PROCESS",guard,sqlState:null,statementIndex:null},undefined,
    {exitCode:Number.isInteger(exitCode) && Number(exitCode)>=0 && Number(exitCode)<=255?Number(exitCode):null,
      signal:typeof signal==="string"&&signals.has(signal)?signal:null});
}
export function parseLiveChildFailure(value:unknown) {
  if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("LIVE_CHILD_FAILURE_INVALID");
  const row=value as Record<string,unknown>;
  if(!["code,diagnostic","code,diagnostic,mappingReviewEvidence"].includes(Object.keys(row).sort().join(",")) || typeof row.code!=="string" || !SAFE_SYNC_CODES.has(row.code))throw new Error("LIVE_CHILD_FAILURE_INVALID");
  const diagnostic=row.diagnostic as Cafe24LiveChildDiagnostic|null;
  if(!diagnostic || Object.keys(diagnostic).sort().join(",")!=="category,guard,sqlState,statementIndex" ||
    !(LIVE_CHILD_STAGES as readonly string[]).includes(diagnostic.category) || diagnostic.statementIndex!==null ||
    (diagnostic.guard!==null && !(LIVE_CHILD_GUARDS as readonly string[]).includes(diagnostic.guard)) ||
    (diagnostic.sqlState!==null && !sqlStates.has(diagnostic.sqlState)))throw new Error("LIVE_CHILD_FAILURE_INVALID");
  if(diagnostic.guard!==null && (CAFE24_ACTIVATION_GUARDS as readonly string[]).includes(diagnostic.guard) && (diagnostic.category!=="CHILD_ACTIVATE" || row.code!=="SOURCE_SELECTION_REQUIRED"))throw new Error("LIVE_CHILD_FAILURE_INVALID");
  return new Cafe24LiveChildFailure(row.code,diagnostic,"mappingReviewEvidence" in row?validateMappingReviewEvidence(row.mappingReviewEvidence):undefined);
}
