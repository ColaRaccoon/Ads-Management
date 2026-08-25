import { IsIn } from "class-validator";

export const RECONCILE_ACTIONS = ["RETRY_INVITATION", "CANCEL"] as const;
export type ReconcileInvitationAction = typeof RECONCILE_ACTIONS[number];

export class ReconcileInvitationDto {
  @IsIn(RECONCILE_ACTIONS)
  action!: ReconcileInvitationAction;
}
