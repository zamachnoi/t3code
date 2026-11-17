import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeWorkspaceRepositories } from "../vcs/workspaceRepositories.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { removeEmptyDirectory } from "../vcs/removeEmptyDirectory.ts";
import * as GitManager from "./GitManager.ts";

const MANIFEST = ".t3-workspace.json";
const Manifest = Schema.Struct({
  sourceRoot: Schema.String,
  repositories: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));

export const makeWorkspaceWorktrees = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const manager = yield* GitManager.GitManager;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const listRepositories = yield* makeWorkspaceRepositories;
  const home = yield* HostProcess.HomeDirectory;
  const error = (cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: "GitWorkflowService.workspaceWorktree",
      cwd,
      command: "git worktree",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const remove = Effect.fn("GitWorkflowService.removeWorkspaceWorktree")(function* (
    input: VcsRemoveWorktreeInput,
  ) {
    const root = yield* fs
      .realPath(path.resolve(input.cwd, input.path))
      .pipe(
        Effect.mapError((cause) =>
          error(input.cwd, "Could not resolve the workspace folder.", cause),
        ),
      );
    const manifest = yield* fs.readFileString(path.join(root, MANIFEST)).pipe(
      Effect.flatMap(decodeManifest),
      Effect.mapError((cause) =>
        error(input.cwd, "Could not read the multi-repository workspace manifest.", cause),
      ),
    );
    const sourceRoot = yield* fs
      .realPath(input.cwd)
      .pipe(
        Effect.mapError((cause) =>
          error(input.cwd, "Could not resolve the source project.", cause),
        ),
      );
    if (
      manifest.sourceRoot !== sourceRoot ||
      manifest.repositories.length === 0 ||
      manifest.repositories.some(
        (name) => name === "." || name === ".." || path.basename(name) !== name,
      )
    ) {
      return yield* error(input.cwd, "The workspace does not belong to this project.");
    }
    const entries = yield* fs
      .readDirectory(root)
      .pipe(
        Effect.mapError((cause) => error(root, "Could not inspect the workspace folder.", cause)),
      );
    if (entries.some((name) => name !== MANIFEST && !manifest.repositories.includes(name)))
      return yield* error(root, "The workspace contains files outside its repository worktrees.");
    // Validate every registration and dirty checkout before removing the first one.
    for (const name of manifest.repositories) {
      const cwd = path.join(input.cwd, name);
      const checkout = path.join(root, name);
      if (
        !(yield* fs
          .exists(checkout)
          .pipe(
            Effect.mapError((cause) =>
              error(cwd, "Could not inspect a workspace checkout.", cause),
            ),
          ))
      )
        continue;
      const registered = yield* Effect.forEach(yield* git.listWorktreePaths(cwd), (value) =>
        fs.realPath(value).pipe(Effect.orElseSucceed(() => value)),
      );
      if (!registered.includes(checkout))
        return yield* error(
          cwd,
          "A workspace checkout is not registered with its source repository.",
        );
      if (!input.force) {
        const status = yield* git.execute({
          operation: "workspaceWorktree.status",
          cwd: checkout,
          args: [
            "-c",
            "status.showUntrackedFiles=all",
            "status",
            "--porcelain",
            "--ignore-submodules=none",
          ],
        });
        if (status.stdout !== "")
          return yield* error(
            checkout,
            "The workspace contains modified or untracked files. Use force to remove it.",
          );
      }
    }
    for (const name of manifest.repositories) {
      const checkout = path.join(root, name);
      if (yield* fs.exists(checkout).pipe(Effect.orElseSucceed(() => true)))
        yield* git.removeWorktree({
          cwd: path.join(input.cwd, name),
          path: checkout,
          ...(input.force === undefined ? {} : { force: input.force }),
        });
    }
    const remaining = yield* fs
      .readDirectory(root)
      .pipe(
        Effect.mapError((cause) => error(root, "Could not inspect the workspace folder.", cause)),
      );
    if (remaining.some((name) => name !== MANIFEST))
      return yield* error(root, "The workspace contains files outside its repository worktrees.");
    yield* fs
      .remove(path.join(root, MANIFEST))
      .pipe(
        Effect.mapError((cause) => error(root, "Could not remove the workspace manifest.", cause)),
      );
    if (
      !(yield* removeEmptyDirectory(root).pipe(
        Effect.mapError((cause) =>
          error(root, "Could not remove the empty workspace folder.", cause),
        ),
      ))
    )
      return yield* error(root, "The workspace folder is no longer empty.");
  });

  const create = Effect.fn("GitWorkflowService.createWorkspaceWorktree")(function* (
    input: VcsCreateWorktreeInput,
    options?: GitVcsDriver.CreateWorktreeOptions,
  ) {
    const repositories = yield* listRepositories(input.cwd).pipe(
      Effect.mapError((cause) =>
        error(input.cwd, "Could not discover project repositories.", cause),
      ),
    );
    if (repositories.length === 0 || repositories.some((repo) => repo.prefix === ""))
      return yield* error(input.cwd, "The project must contain immediate child repositories.");
    const branch = input.newRefName ?? input.refName;
    for (const repository of repositories) {
      const refs = yield* git.listLocalBranchNames(repository.cwd);
      if (
        input.newRefName &&
        refs.some(
          (ref) => ref === branch || ref.startsWith(`${branch}/`) || branch.startsWith(`${ref}/`),
        )
      )
        return yield* error(
          repository.cwd,
          "The requested branch conflicts with an existing branch.",
        );
      yield* git.resolveCommit({
        cwd: repository.cwd,
        revision: input.newRefName ? "HEAD" : input.refName,
      });
    }
    const configured = yield* settings.getSettings.pipe(
      Effect.map((value) => value.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const directory = resolveWorktreesDirectory(
      options?.worktreesDirectory ?? configured,
      config.worktreesDir,
      path,
      home,
    );
    if (directory === null)
      return yield* error(input.cwd, "Choose an absolute worktree directory in Settings.");
    const parent = path.join(directory, path.basename(path.resolve(input.cwd)));
    const io = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          error(input.cwd, "Could not prepare the workspace folder.", cause),
        ),
      );
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* io(fs.makeDirectory(parent, { recursive: true }));
        const requestedRoot =
          input.path === null
            ? yield* io(
                fs.makeTempDirectory({
                  directory: parent,
                  prefix: `${branch.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30)}-`,
                }),
              )
            : path.resolve(input.cwd, input.path);
        if (input.path !== null) yield* io(fs.makeDirectory(requestedRoot));
        const root = yield* io(fs.realPath(requestedRoot));
        const names = repositories.map((repo) => path.basename(repo.cwd));
        const claimed = new Set<string>();
        return yield* Effect.gen(function* () {
          yield* io(
            fs.writeFileString(
              path.join(root, MANIFEST),
              yield* io(
                encodeManifest({
                  sourceRoot: yield* io(fs.realPath(input.cwd)),
                  repositories: names,
                }),
              ),
            ),
          );
          for (const repository of repositories) {
            const checkout = path.join(root, path.basename(repository.cwd));
            yield* restore(
              manager.createWorktree(
                {
                  cwd: repository.cwd,
                  refName: input.newRefName ? "HEAD" : input.refName,
                  ...(input.newRefName === undefined
                    ? {}
                    : { newRefName: input.newRefName, baseRefName: "HEAD" }),
                  path: checkout,
                },
                {
                  ...options,
                  progress: {
                    ...options?.progress,
                    onWorktreeClaimed: () =>
                      Effect.sync(() => {
                        claimed.add(repository.cwd);
                      }),
                  },
                },
              ),
            );
          }
          yield* options?.progress?.onWorktreeClaimed?.(root) ?? Effect.void;
          return { worktree: { path: root, refName: branch } };
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.gen(function* () {
                  for (const repo of repositories) {
                    const checkout = path.join(root, path.basename(repo.cwd));
                    if ((yield* git.listWorktreePaths(repo.cwd)).includes(checkout))
                      claimed.add(repo.cwd);
                  }
                  yield* remove({ cwd: input.cwd, path: root, force: true });
                }).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      Effect.forEach(
                        [...claimed],
                        (cwd) =>
                          input.newRefName
                            ? git
                                .deleteLocalBranch({ cwd, refName: branch, force: true })
                                .pipe(Effect.ignore)
                            : Effect.void,
                        { discard: true },
                      ),
                    ),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not clean up a failed multi-repository workspace", {
                      cause,
                    }),
                  ),
                )
              : Effect.void,
          ),
        );
      }),
    );
  });
  return { create, remove };
});
