export type Cafe24MappingReviewEvidence={csvMappingChangedLineCount:number|null;csvMappingStateDigest:string;configurationStateDigest:string};
export class Cafe24MappingReviewChanged extends Error {
  constructor(readonly evidence:Cafe24MappingReviewEvidence) {super("CONFIGURATION_MAPPING_REVIEW_METADATA_CHANGED");}
}
export function validateMappingReviewEvidence(value:unknown):Cafe24MappingReviewEvidence {
  const row=value as Record<string,unknown>|null;
  if(!row || typeof row!=="object" || Array.isArray(row) || Object.keys(row).sort().join(",")!=="configurationStateDigest,csvMappingChangedLineCount,csvMappingStateDigest" ||
    (row.csvMappingChangedLineCount!==null && (!Number.isSafeInteger(row.csvMappingChangedLineCount) || Number(row.csvMappingChangedLineCount)<10 || Number(row.csvMappingChangedLineCount)>477 ||
      (477-Number(row.csvMappingChangedLineCount)>0 && 477-Number(row.csvMappingChangedLineCount)<10))) ||
    typeof row.csvMappingStateDigest!=="string" || !/^[a-f0-9]{64}$/.test(row.csvMappingStateDigest) ||
    typeof row.configurationStateDigest!=="string" || !/^[a-f0-9]{64}$/.test(row.configurationStateDigest))throw new Error("LIVE_MAPPING_EVIDENCE_INVALID");
  return row as Cafe24MappingReviewEvidence;
}
