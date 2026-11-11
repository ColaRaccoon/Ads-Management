import { CreativeNameParser } from "../domain/creative-name-parser";

const parser = new CreativeNameParser();
const marker = /(?:^|[^\p{L}\p{N}])인플\s*\(([^()]+)\)/gu;

export function influencerKey(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function materialNumberKey(productId: string, managerName: string, number: string) {
  return `${productId}:${influencerKey(managerName)}:${number.replace(/^0+(?=\d)/, "")}`;
}

export function numberedCreative(adName: string) {
  const normalized = adName.normalize("NFKC");
  if (Array.from(normalized.matchAll(marker)).length !== 1) return null;
  const { materialNo, displayName } = parser.parse(normalized);
  const match = (materialNo ?? displayName).match(/^인플\s*\(([^()]+)\)\s*([0-9]{1,16})(?:번소재)?$/u);
  if (!match) return null;
  const managerKey = influencerKey(match[1]);
  return managerKey && managerKey.length <= 100 ? { number: match[2], managerKey, creativeName: displayName } : null;
}
