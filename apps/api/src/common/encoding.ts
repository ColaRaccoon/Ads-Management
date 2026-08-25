export const MAX_UPLOAD_DISPLAY_FILENAME_LENGTH = 180;

export function normalizeUploadedFilename(filename: string): string {
  return sanitizeUploadedFilename(filename);
}

export function sanitizeUploadedFilename(filename: string): string {
  const normalized = decodeLegacyFilename(String(filename ?? "")).replace(/\\/g, "/");
  const basename = normalized.split("/").at(-1) ?? "";
  const withoutControls = basename
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const safeName = truncateFilename(withoutControls, MAX_UPLOAD_DISPLAY_FILENAME_LENGTH);
  if (!safeName || safeName === "." || safeName === "..") {
    return "upload";
  }
  return safeName;
}

function decodeLegacyFilename(filename: string): string {
  const normalized = filename.normalize("NFC");
  const decodedFromLatin1 = Buffer.from(normalized, "latin1").toString("utf8").normalize("NFC");
  return koreanTextScore(decodedFromLatin1) > koreanTextScore(normalized) ? decodedFromLatin1 : normalized;
}

function truncateFilename(filename: string, maxLength: number) {
  const characters = Array.from(filename);
  if (characters.length <= maxLength) {
    return filename;
  }
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";
  const extensionCharacters = Array.from(extension).slice(0, 20);
  const baseLength = Math.max(1, maxLength - extensionCharacters.length);
  return `${characters.slice(0, baseLength).join("")}${extensionCharacters.join("")}`;
}

function koreanTextScore(value: string) {
  const hangulCount = Array.from(value).filter((char) => /[가-힣]/.test(char)).length;
  const replacementCount = Array.from(value).filter((char) => char === "\uFFFD").length;
  const mojibakeMarkerCount = Array.from(value).filter((char) => /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(char)).length;
  return hangulCount * 5 - replacementCount * 20 - mojibakeMarkerCount * 2;
}
