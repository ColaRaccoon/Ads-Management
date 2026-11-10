import { CreativeNameParser } from "../domain/creative-name-parser";

const parser = new CreativeNameParser();
const marker = /(?:^|[^\p{L}\p{N}])인플\s*\(([^()]+)\)/gu;

export function influencerKey(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function keysIn(label: string) {
  return [...new Set(Array.from(label.normalize("NFKC").matchAll(marker), (match) => influencerKey(match[1]))
    .filter((key) => key.length > 0 && key.length <= 100))];
}

export function classifyInfluencerCreative(adName: string, campaignName: string) {
  const adKeys = keysIn(adName);
  const keys = adKeys.length ? adKeys : keysIn(campaignName);
  if (keys.length !== 1) return null;
  const creativeName = parser.parse(adName.normalize("NFKC")).displayName;
  return creativeName ? { influencerKey: keys[0], creativeName } : null;
}

export function materialNumberKey(productId: string, number: string) {
  return `${productId}:${number.replace(/^0+(?=\d)/, "")}`;
}

export function numberedCreative(adName: string) {
  const { materialNo, displayName } = parser.parse(adName.normalize("NFKC"));
  const number = materialNo?.match(/([0-9]+)(?:번소재)?$/)?.[1];
  return number && number.length <= 16 ? { number, creativeName: displayName } : null;
}
