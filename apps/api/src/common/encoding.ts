export function normalizeUploadedFilename(filename: string): string {
  const normalized = filename.normalize("NFC");
  const decodedFromLatin1 = Buffer.from(normalized, "latin1").toString("utf8").normalize("NFC");
  return koreanTextScore(decodedFromLatin1) > koreanTextScore(normalized) ? decodedFromLatin1 : normalized;
}

function koreanTextScore(value: string) {
  const hangulCount = Array.from(value).filter((char) => /[가-힣]/.test(char)).length;
  const replacementCount = Array.from(value).filter((char) => char === "\uFFFD").length;
  const mojibakeMarkerCount = Array.from(value).filter((char) => /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(char)).length;
  return hangulCount * 5 - replacementCount * 20 - mojibakeMarkerCount * 2;
}
