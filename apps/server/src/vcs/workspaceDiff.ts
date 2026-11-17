import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

// Git's src/dst prefixes do not apply to its separate rename and copy headers.
export function prefixRenameHeaders(diff: string, prefix: string): string {
  return diff.replace(
    /^(rename from |rename to |copy from |copy to )(.+)$/gm,
    (_, header: string, file: string) =>
      header + quoteGitPatchPath(prefix + unquoteGitPatchPath(file)),
  );
}

export function prefixNumstat(numstat: string, prefix: string): string {
  const records = numstat.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;
    if (record.length > counts[0].length) {
      records[index] = counts[0] + prefix + record.slice(counts[0].length);
    } else {
      records[index + 1] = prefix + records[index + 1];
      records[index + 2] = prefix + records[index + 2];
      index += 2;
    }
  }
  return records.join("\0");
}
