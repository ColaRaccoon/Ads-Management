import { measureExplicitUploadMetadata, type ExplicitMetadataInput } from "./upload-metadata-measurement";
import { UPLOAD_PROFILES, type UploadProfileId } from "./upload-profiles";

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const result = await measureExplicitUploadMetadata(parsed.inputs, {
    approvedRoot: parsed.approvedRoot,
    originalBusinessRoot: parsed.forbiddenRoot
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseArguments(args: string[]) {
  let approvedRoot = "";
  let forbiddenRoot = "";
  const inputs: ExplicitMetadataInput[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--approved-root") {
      approvedRoot = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--forbidden-root") {
      forbiddenRoot = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--input") {
      const raw = args[index + 1] ?? "";
      index += 1;
      const separator = raw.indexOf("=");
      const profile = raw.slice(0, separator) as UploadProfileId;
      const absolutePath = raw.slice(separator + 1);
      if (separator <= 0 || !UPLOAD_PROFILES[profile]) throw new Error("METADATA_ARGUMENT_INVALID");
      inputs.push({ profile, absolutePath });
      continue;
    }
    throw new Error("METADATA_ARGUMENT_INVALID");
  }
  if (!approvedRoot || !forbiddenRoot || inputs.length === 0) throw new Error("METADATA_ARGUMENT_INVALID");
  return { approvedRoot, forbiddenRoot, inputs };
}

main().catch(() => {
  process.stderr.write('{"code":"METADATA_MEASUREMENT_FAILED"}\n');
  process.exitCode = 1;
});
