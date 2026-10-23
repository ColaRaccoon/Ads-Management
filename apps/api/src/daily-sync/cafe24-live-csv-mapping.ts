import {createHmac} from "node:crypto";
import {Cafe24OrderLine,Prisma,PrismaClient,SourceKind} from "@prisma/client";
import {Cafe24MatchResult,Cafe24ProductMatcher,Cafe24RuleInput} from "../domain/cafe24-matcher";
import {Cafe24MappingReviewChanged} from "./cafe24-live-mapping-review-error";
import {cafe24ObservationKey} from "./cafe24-observed-revision";

export function csvMappingMetadataEquivalent(row:Pick<Cafe24OrderLine,"productId"|"cafe24ProductRuleId"|"matchSource"|"validationStatus"|"validationErrors">,match:Cafe24MatchResult) {
  if(row.validationStatus==="ERROR" || !Array.isArray(row.validationErrors))throw new Error("CONFIGURATION_MAPPING_REVIEW_METADATA_INVALID");
  const errors=row.validationErrors;
  for(const error of errors) {
    if(!error || typeof error!=="object" || Array.isArray(error) ||
      Object.keys(error).some(field=>!["columnName","errorCode","message","rawValue","severity"].includes(field)) ||
      (error.columnName!==null && typeof error.columnName!=="string") || typeof error.errorCode!=="string" ||
      !/^[A-Z0-9_]{1,96}$/.test(error.errorCode) || typeof error.message!=="string" ||
      (error.rawValue!==undefined && error.rawValue!==null && typeof error.rawValue!=="string") || error.severity!=="WARNING")
      throw new Error("CONFIGURATION_MAPPING_REVIEW_METADATA_INVALID");
  }
  const matchingErrors=errors.filter(error=>["CAFE24_PRODUCT_UNMATCHED","CAFE24_PRODUCT_AMBIGUOUS"].includes(String((error as Record<string,unknown>).errorCode)));
  const retainedCount=errors.length-matchingErrors.length;
  const expectedStatus=match.reason==="MATCHED" ? retainedCount ? "WARNING" : "VALID" : match.reason==="AMBIGUOUS_MATCH"?"WARNING":"UNMATCHED";
  const expectedError=match.reason==="MATCHED"?null:match.reason==="AMBIGUOUS_MATCH"?"CAFE24_PRODUCT_AMBIGUOUS":"CAFE24_PRODUCT_UNMATCHED";
  const expectedMessage=match.reason==="AMBIGUOUS_MATCH"?"Cafe24 order line matched more than one active rule.":"Cafe24 order line did not match any active product rule.";
  const issueMismatch=expectedError===null ? matchingErrors.length!==0 : matchingErrors.length!==1 ||
    (matchingErrors[0] as Record<string,unknown>).errorCode!==expectedError ||
    (matchingErrors[0] as Record<string,unknown>).columnName!==null ||
    (matchingErrors[0] as Record<string,unknown>).message!==expectedMessage ||
    (match.reason==="AMBIGUOUS_MATCH" ? (matchingErrors[0] as Record<string,unknown>).rawValue!==match.candidates.join(", ") :
      (matchingErrors[0] as Record<string,unknown>).rawValue!==undefined);
  return row.productId===match.productId && row.cafe24ProductRuleId===match.matchRuleId && row.matchSource===match.source &&
    row.validationStatus===expectedStatus && !issueMismatch;
}

/** Before any configuration write, compare all original CSV rows with the
 * corrected source rules using the exact shared matcher. Never rematch here. */
export async function verifyCsvMappingForDateRepair(db:PrismaClient|Prisma.TransactionClient,connectionId:string,rules:Cafe24RuleInput[],configurationStateDigest:string) {
  await db.$queryRaw`SELECT id FROM cafe24_order_lines WHERE source='CSV' AND is_current ORDER BY id FOR UPDATE`;
  const rows=await db.cafe24OrderLine.findMany({where:{connectionId,source:SourceKind.CSV,isCurrent:true},orderBy:{id:"asc"}});
  const policy=await db.sourcePolicy.findMany({where:{connectionId,dataKind:"CAFE24_ORDER",fromDate:{lte:new Date("2026-10-01")},OR:[{toDate:null},{toDate:{gt:new Date("2026-10-01")}}]}});
  if(rows.length!==477 || new Set(rows.map(row=>row.orderNo)).size!==422 || rows.filter(row=>!row.orderDate).length!==3 ||
    rows.some(row=>row.orderDate && row.orderDate.toISOString().slice(0,10)!=="2026-10-01") ||
    await db.cafe24OrderLine.count({where:{source:SourceKind.CSV,isCurrent:true}})!==477 ||
    await db.cafe24OrderLine.count({where:{source:SourceKind.API,isCurrent:true}})!==0 ||
    policy.length!==1 || policy[0].primarySource!=="CSV")throw new Error("CONFIGURATION_MAPPING_REVIEW_SCOPE_INVALID");
  const matcher=new Cafe24ProductMatcher();
  const changed=rows.filter(row=> {
    const match=matcher.match(row,rules);
    return !csvMappingMetadataEquivalent(row,match);
  });
  if(changed.length) {
    const {key}=cafe24ObservationKey();
    const unchanged=477-changed.length;
    try {throw new Cafe24MappingReviewChanged({csvMappingChangedLineCount:changed.length<10 || (unchanged>0&&unchanged<10)?null:changed.length,
      configurationStateDigest,csvMappingStateDigest:createHmac("sha256",key).update(JSON.stringify(rows)).digest("hex")});}
    finally {key.fill(0);}
  }
  return {csvMappingReviewedLineCount:477,csvMappingChangedLineCount:0,csvMappingEquivalent:true,
    csvOriginalContentPreserved:true,csvUndatedMappingPreserved:true,csvRematchPerformed:false};
}
