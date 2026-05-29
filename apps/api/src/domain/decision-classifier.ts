import type { AdStageValue } from "./matching";

export type DecisionTypeValue =
  | "SCALE"
  | "KEEP"
  | "WATCH"
  | "STOP_CANDIDATE"
  | "SC_TO_CBO"
  | "CBO_TO_ASC"
  | "SC_TO_ASC"
  | "ASC_TO_SC"
  | "PROFIT"
  | "LOSS";

export type DecisionInput = {
  scopeType?: "OVERALL" | "PRODUCT" | "ADSET" | "STAGE";
  stage: AdStageValue;
  purchaseCount: number;
  spendKrw: number;
  cpaKrw: number | null;
  marginKrw: number | null;
  dataDays: number;
  ctrLinkPct: number | null;
  landingPageViews: number;
  breakEvenCpaKrw: number | null;
  targetCpaKrw: number | null;
  watchCpaKrw: number | null;
  stopCpaKrw: number | null;
  goodCtrLinkPct: number;
  goodLandingPageViewCount: number;
};

export type ClassifiedDecision = {
  decision: DecisionTypeValue;
  severity: number;
  reason: string;
  recommendedAction: string;
};

export class DecisionClassifier {
  classify(input: DecisionInput): ClassifiedDecision[] {
    const decisions: ClassifiedDecision[] = [];

    if ((input.scopeType === "OVERALL" || input.scopeType === "PRODUCT") && input.marginKrw !== null) {
      decisions.push(
        input.marginKrw > 0
          ? {
              decision: "PROFIT",
              severity: 1,
              reason: "선택 기간 마진이 0보다 큽니다.",
              recommendedAction: "현재 수익 구조를 유지하며 확장 후보를 검토하세요."
            }
          : {
              decision: "LOSS",
              severity: 3,
              reason: "선택 기간 마진이 0보다 작습니다.",
              recommendedAction: "원가 기준과 광고 지출을 함께 점검하세요."
            }
      );
    }

    if (input.targetCpaKrw !== null && input.cpaKrw !== null && input.purchaseCount > 0 && input.marginKrw !== null) {
      if (input.cpaKrw <= input.targetCpaKrw && input.marginKrw > 0) {
        decisions.push({
          decision: "SCALE",
          severity: 1,
          reason: "구매가 있고 CPA가 목표 CPA 이내이며 마진이 양수입니다.",
          recommendedAction: "예산 증액 후보로 검토하세요."
        });
      } else if (
        input.breakEvenCpaKrw !== null &&
        input.cpaKrw > input.targetCpaKrw &&
        input.cpaKrw <= input.breakEvenCpaKrw &&
        input.marginKrw >= 0
      ) {
        decisions.push({
          decision: "KEEP",
          severity: 1,
          reason: "구매가 있고 CPA가 손익분기 CPA 이내이며 마진이 음수가 아닙니다.",
          recommendedAction: "현재 운영을 유지하며 추이를 관찰하세요."
        });
      } else if (
        input.breakEvenCpaKrw !== null &&
        input.watchCpaKrw !== null &&
        input.cpaKrw > input.breakEvenCpaKrw &&
        input.cpaKrw <= input.watchCpaKrw &&
        input.marginKrw >= 0
      ) {
        decisions.push({
          decision: "WATCH",
          severity: 2,
          reason: "구매가 있지만 CPA가 손익분기 CPA를 넘어 관찰 CPA 범위에 있습니다.",
          recommendedAction: "소재와 타겟을 점검하고 다음 데이터 일자에서 재평가하세요."
        });
      }
    }

    if (
      input.stage === "SC" &&
      input.purchaseCount === 0 &&
      input.stopCpaKrw !== null &&
      input.spendKrw < input.stopCpaKrw &&
      ((input.ctrLinkPct ?? 0) >= input.goodCtrLinkPct ||
        input.landingPageViews >= input.goodLandingPageViewCount)
    ) {
      decisions.push({
        decision: "WATCH",
        severity: 2,
        reason: "SC 단계에서 구매는 없지만 지출이 중단 후보 CPA 미만이고 클릭/랜딩 신호가 있습니다.",
        recommendedAction: "테스트를 유지하고 다음 데이터 일자에서 재평가하세요."
      });
    }

    const stopByNoPurchase =
      input.purchaseCount === 0 && input.stopCpaKrw !== null && input.spendKrw >= input.stopCpaKrw;
    const stopByCpa =
      input.purchaseCount > 0 &&
      input.cpaKrw !== null &&
      input.stopCpaKrw !== null &&
      input.cpaKrw > input.stopCpaKrw;
    const stopByMargin = input.marginKrw !== null && input.marginKrw < 0 && input.dataDays >= 2;
    if (stopByNoPurchase || stopByCpa || stopByMargin) {
      decisions.push({
        decision: "STOP_CANDIDATE",
        severity: 3,
        reason: "중단 후보 조건에 도달했습니다.",
        recommendedAction: "중단 또는 예산 축소 후보로 변경 로그에 기록하세요."
      });
    }

    if (
      input.stage === "SC" &&
      input.purchaseCount >= 1 &&
      input.cpaKrw !== null &&
      input.breakEvenCpaKrw !== null &&
      input.cpaKrw <= input.breakEvenCpaKrw
    ) {
      decisions.push({
        decision: "SC_TO_CBO",
        severity: 1,
        reason: "SC 단계에서 구매가 있고 CPA가 손익분기 CPA 이내입니다.",
        recommendedAction: "CBO 전환 후보로 검토하세요."
      });
    }

    if (
      input.stage === "SC" &&
      input.purchaseCount >= 2 &&
      input.cpaKrw !== null &&
      input.targetCpaKrw !== null &&
      input.cpaKrw <= input.targetCpaKrw &&
      (input.marginKrw ?? 0) > 0
    ) {
      decisions.push({
        decision: "SC_TO_ASC",
        severity: 1,
        reason: "SC 단계에서 구매 2건 이상, 목표 CPA 이내, 양수 마진입니다.",
        recommendedAction: "ASC 전환 후보로 검토하세요."
      });
    }

    if (
      input.stage === "CBO" &&
      input.dataDays >= 2 &&
      input.purchaseCount >= 2 &&
      input.cpaKrw !== null &&
      input.breakEvenCpaKrw !== null &&
      input.cpaKrw <= input.breakEvenCpaKrw &&
      (input.marginKrw ?? 0) > 0
    ) {
      decisions.push({
        decision: "CBO_TO_ASC",
        severity: 1,
        reason: "CBO 단계에서 2일 이상 데이터, 구매 2건 이상, 손익분기 CPA 이내, 양수 마진입니다.",
        recommendedAction: "ASC 전환 후보로 검토하세요."
      });
    }

    if (
      input.stage === "ASC" &&
      input.dataDays >= 2 &&
      ((input.cpaKrw !== null && input.stopCpaKrw !== null && input.cpaKrw > input.stopCpaKrw) ||
        (input.marginKrw ?? 0) < 0)
    ) {
      decisions.push({
        decision: "ASC_TO_SC",
        severity: 3,
        reason: "ASC 단계에서 CPA 급등 또는 마진 악화가 확인되었습니다.",
        recommendedAction: "SC 재테스트 또는 구조 변경 후보로 검토하세요."
      });
    }

    return decisions;
  }
}
