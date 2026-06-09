import { describe, expect, it } from "vitest";
import { CreativeNameParser } from "./creative-name-parser";

describe("CreativeNameParser", () => {
  const parser = new CreativeNameParser();

  it("parses date, product, and material from the current ad naming rule", () => {
    const result = parser.parse("260606_버닝웨이브바_04");

    expect(result.dateCode).toBe("260606");
    expect(result.productName).toBe("버닝웨이브바");
    expect(result.materialNo).toBe("04");
    expect(result.creativeKey).toBe("버닝웨이브바_04");
    expect(result.parseStatus).toBe("PARSED");
  });

  it.each([
    ["260605_플로우라이트_0011_인플연동", "260605", "플로우라이트", "0011", "플로우라이트_0011", "인플연동"],
    ["260605_플로우라이트_인플연동_0010", "260605", "플로우라이트", "0010", "플로우라이트_0010", "인플연동"],
    ["버닝슬라이드_인플연동_0001", null, "버닝슬라이드", "0001", "버닝슬라이드_0001", "인플연동"],
    ["260604_플로우라이트_I0001", "260604", "플로우라이트", "I0001", "플로우라이트_I0001", null],
    ["260605_유쉴드마스크_0002", "260605", "유쉴드마스크", "0002", "유쉴드마스크_0002", null]
  ])("keeps method tokens out of product and material for %s", (adName, dateCode, productName, materialNo, creativeKey, setting) => {
    const result = parser.parse(adName);

    expect(result.dateCode).toBe(dateCode);
    expect(result.productName).toBe(productName);
    expect(result.materialNo).toBe(materialNo);
    expect(result.creativeKey).toBe(creativeKey);
    expect(result.setting).toBe(setting);
    expect(result.parseStatus).toBe("PARSED");
  });
});
