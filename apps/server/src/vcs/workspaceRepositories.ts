import { VcsRepositoryDetectionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export const makeWorkspaceRepositories = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("workspaceRepositories")(function* (
    cwd: string,
    options?: { readonly strict?: boolean },
  ) {
    const detect = options?.strict
      ? (yield* registry.get("git")).detectRepository
      : (cwd: string) =>
          registry.detect({ cwd }).pipe(Effect.map((handle) => handle?.repository ?? null));
    const repository = yield* detect(cwd);
    if (
      repository !== null &&
      (yield* fs.exists(path.join(cwd, ".git")).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation: "workspaceRepositories",
              cwd,
              detail: "Could not inspect project metadata.",
              cause,
            }),
        ),
      ))
    )
      return [{ cwd, prefix: "" }];
    const entries = yield* fs.readDirectory(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed([] as string[])
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "workspaceRepositories",
                  cwd,
                  detail: "Could not read project repositories.",
                  cause,
                }),
              ),
      }),
    );
    const repositories: Array<{ readonly cwd: string; readonly prefix: string }> = [];
    for (const name of entries.toSorted()) {
      const child = path.join(cwd, name);
      const isRepositoryFolder = yield* Effect.all([
        fs.lstat(child).pipe(Effect.map((info) => info.type === "Directory")),
        fs.exists(path.join(child, ".git")),
      ]).pipe(
        Effect.map(([directory, git]) => directory && git),
        Effect.orElseSucceed(() => false),
      );
      if (isRepositoryFolder && (yield* detect(child)) !== null)
        repositories.push({ cwd: child, prefix: `${name}/` });
    }
    return repositories.length === 0 && repository !== null ? [{ cwd, prefix: "" }] : repositories;
  });
});
