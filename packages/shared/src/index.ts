export type DecisionType =
  | 'SCALE'
  | 'KEEP'
  | 'WATCH'
  | 'STOP_CANDIDATE'
  | 'SC_TO_CBO'
  | 'CBO_TO_ASC'
  | 'SC_TO_ASC'
  | 'ASC_TO_SC'
  | 'PROFIT'
  | 'LOSS';

export type AdStage = 'SC' | 'CBO' | 'ASC' | 'UNKNOWN';

export type ConflictPolicy = 'SKIP' | 'OVERWRITE' | 'NEW_VERSION';

export interface DateRangeQuery {
  from: string;
  to: string;
}
