import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { preflightUploadFile, type UploadInspection } from "./upload-preflight";
import { UPLOAD_PROFILES, type UploadProfileId } from "./upload-profiles";

const DEFAULT_ORIGINAL_BUSINESS_ROOT = "C:\\Users\\seong\\Desktop\\workspace\\Meta-Ads-Performance";

export type ExplicitMetadataInput = {
  absolutePath: string;
  profile: UploadProfileId;
};

type NumericSummary = {
  min: number;
  median: number;
  p95: number;
  max: number;
};

export type UploadMetadataSummary = {
  version: 1;
  fileCount: number;
  bundleTotalBytes: number;
  durationMs: number;
  peakRssDeltaBytes: number;
  profiles: Array<{
    profile: UploadProfileId;
    fileCount: number;
    sizeBytes: NumericSummary;
    text?: { rows: NumericSummary; columns: NumericSummary };
    xlsx?: { worksheets: NumericSummary; rows: NumericSummary; columns: NumericSummary };
  }>;
};

export async function measureExplicitUploadMetadata(
  inputs: ExplicitMetadataInput[],
  options: { approvedRoot: string; originalBusinessRoot?: string }
): Promise<UploadMetadataSummary> {
  if (!path.isAbsolute(options.approvedRoot) || inputs.length === 0) {
    throw safeMeasurementError("METADATA_INPUT_INVALID");
  }
  const approvedRootLexical = path.resolve(options.approvedRoot);
  const originalRoot = path.resolve(options.originalBusinessRoot ?? DEFAULT_ORIGINAL_BUSINESS_ROOT);
  if (isWithin(originalRoot, approvedRootLexical)) {
    throw safeMeasurementError("ORIGINAL_BUSINESS_ROOT_FORBIDDEN");
  }

  let approvedRoot: string;
  try {
    const rootStat = await lstat(approvedRootLexical);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw safeMeasurementError("APPROVED_ROOT_INVALID");
    }
    approvedRoot = await realpath(approvedRootLexical);
  } catch (error) {
    if (isSafeMeasurementError(error)) throw error;
    throw safeMeasurementError("APPROVED_ROOT_INVALID");
  }

  const startedAt = performance.now();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  sampler.unref();

  const measurements: Array<{
    profile: UploadProfileId;
    sizeBytes: number;
    inspection: UploadInspection;
  }> = [];
  try {
    for (const input of inputs) {
      const profile = UPLOAD_PROFILES[input.profile];
      if (!profile || !path.isAbsolute(input.absolutePath)) {
        throw safeMeasurementError("METADATA_INPUT_INVALID");
      }
      const lexicalFile = path.resolve(input.absolutePath);
      if (!isWithin(approvedRoot, lexicalFile) || isWithin(originalRoot, lexicalFile)) {
        throw safeMeasurementError("METADATA_PATH_FORBIDDEN");
      }
      let resolvedFile: string;
      let buffer: Buffer;
      try {
        const fileStat = await lstat(lexicalFile);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw safeMeasurementError("METADATA_FILE_INVALID");
        }
        resolvedFile = await realpath(lexicalFile);
        if (!isWithin(approvedRoot, resolvedFile) || isWithin(originalRoot, resolvedFile)) {
          throw safeMeasurementError("METADATA_PATH_FORBIDDEN");
        }
        buffer = await readFile(resolvedFile);
      } catch (error) {
        if (isSafeMeasurementError(error)) throw error;
        throw safeMeasurementError("METADATA_FILE_INVALID");
      }
      const inspection = await preflightUploadFile(
        {
          buffer,
          originalname: path.basename(resolvedFile),
          size: buffer.length
        } as Express.Multer.File,
        profile,
        { requireMime: false }
      );
      measurements.push({ profile: input.profile, sizeBytes: buffer.length, inspection });
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  } finally {
    clearInterval(sampler);
  }

  const profiles = Array.from(new Set(measurements.map((item) => item.profile)))
    .sort()
    .map((profile) => summarizeProfile(profile, measurements.filter((item) => item.profile === profile)));
  return {
    version: 1,
    fileCount: measurements.length,
    bundleTotalBytes: measurements.reduce((total, item) => total + item.sizeBytes, 0),
    durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
    peakRssDeltaBytes: Math.max(0, peakRss - initialRss),
    profiles
  };
}

function summarizeProfile(
  profile: UploadProfileId,
  measurements: Array<{ sizeBytes: number; inspection: UploadInspection }>
) {
  const text = measurements.filter((item) => item.inspection.kind !== "XLSX");
  const xlsx = measurements.filter((item) => item.inspection.kind === "XLSX");
  return {
    profile,
    fileCount: measurements.length,
    sizeBytes: summarize(measurements.map((item) => item.sizeBytes)),
    ...(text.length > 0 ? {
      text: {
        rows: summarize(text.map((item) => item.inspection.kind === "XLSX" ? 0 : item.inspection.rowCount)),
        columns: summarize(text.map((item) => item.inspection.kind === "XLSX" ? 0 : item.inspection.columnCount))
      }
    } : {}),
    ...(xlsx.length > 0 ? {
      xlsx: {
        worksheets: summarize(xlsx.map((item) => item.inspection.kind === "XLSX" ? item.inspection.worksheetCount : 0)),
        rows: summarize(xlsx.map((item) => item.inspection.kind === "XLSX" ? item.inspection.rowCount : 0)),
        columns: summarize(xlsx.map((item) => item.inspection.kind === "XLSX" ? item.inspection.columnCount : 0))
      }
    } : {})
  };
}

function summarize(values: number[]): NumericSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0] ?? 0,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0
  };
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function isWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeMeasurementError(code: string) {
  const error = new Error(code);
  error.name = "UploadMetadataMeasurementError";
  return error;
}

function isSafeMeasurementError(error: unknown) {
  return error instanceof Error && error.name === "UploadMetadataMeasurementError";
}
