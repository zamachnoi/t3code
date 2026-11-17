import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  type ReviewDiffPreviewSource,
  VcsUnsupportedOperationError,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { makeWorkspaceRepositories } from "../vcs/workspaceRepositories.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

const WORKSPACE_BOUND_SUBJECTS = {
  "ReviewService.getBranchCommits": "commit list",
  "ReviewService.getDiffPreview": "diff preview",
  "ReviewService.getDiffFileContents": "diff file contents",
} as const;

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const listRepositories = yield* makeWorkspaceRepositories;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: keyof typeof WORKSPACE_BOUND_SUBJECTS,
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: `Review ${WORKSPACE_BOUND_SUBJECTS[operation]} cwd must stay within the configured workspace root.`,
    });
  });

  const getBranchCommits: ReviewService["Service"]["getBranchCommits"] = Effect.fn(
    "ReviewService.getBranchCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getBranchCommits", input.cwd);

    const repositories = yield* listRepositories(input.cwd);
    if (repositories[0]?.prefix !== "") return { commits: [], truncated: false };
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) return { commits: [], truncated: false };
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getBranchCommits",
        kind: handle.kind,
        detail: "Review commit lists require a Git repository.",
      });
    }
    return yield* git.getReviewBranchCommits(input);
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const repositories = yield* listRepositories(input.cwd);
    if (repositories[0]?.prefix === "") return yield* git.getReviewDiffPreview(input);
    const sources = new Map<string, ReviewDiffPreviewSource>();
    let incomplete = false;
    for (const repository of repositories) {
      const file = input.file;
      if (
        file &&
        (!file.path.startsWith(repository.prefix) ||
          (file.previousPath !== null && !file.previousPath.startsWith(repository.prefix)))
      )
        continue;
      const preview = yield* git.getReviewDiffPreview(
        {
          ...input,
          cwd: repository.cwd,
          ...(file
            ? {
                file: {
                  ...file,
                  path: file.path.slice(repository.prefix.length),
                  previousPath: file.previousPath?.slice(repository.prefix.length) ?? null,
                },
              }
            : {}),
        },
        { pathPrefix: repository.prefix },
      );
      incomplete ||= preview.incomplete ?? false;
      for (const source of preview.sources) {
        const { files: sourceFiles, ...sourceWithoutFiles } = source;
        const previous = sources.get(source.kind);
        const files = sourceFiles?.map((file) => ({
          ...file,
          path: repository.prefix + file.path,
          previousPath: file.previousPath === null ? null : repository.prefix + file.previousPath,
        }));
        const diff = (previous?.diff ?? "") + source.diff;
        sources.set(source.kind, {
          ...sourceWithoutFiles,
          id: source.kind,
          baseRef: source.kind === "working-tree" ? "HEAD" : null,
          headRef: null,
          diff: diff.slice(0, input.file ? 1_048_576 : 120_000),
          diffHash: (previous?.diffHash ?? "") + repository.prefix + source.diffHash,
          truncated:
            source.truncated ||
            previous?.truncated === true ||
            diff.length > (input.file ? 1_048_576 : 120_000),
          ...(files !== undefined && (previous === undefined || previous.files !== undefined)
            ? { files: [...(previous?.files ?? []), ...files] }
            : {}),
          patchesDeferred:
            source.patchesDeferred === true &&
            (previous === undefined || previous.patchesDeferred === true),
        });
      }
    }
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [...sources.values()],
      ...(incomplete ? { incomplete: true } : {}),
    };
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const repositories = yield* listRepositories(input.cwd);
    const repository = repositories.find(
      (repo) => input.newPath.startsWith(repo.prefix) && input.oldPath.startsWith(repo.prefix),
    );
    if (!repository)
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: "unknown",
        detail: "The file must belong to one project repository.",
      });
    if (repository.prefix === "") return yield* git.getReviewDiffFileContents(input);
    const preview = yield* git.getReviewDiffPreview({
      cwd: repository.cwd,
      ...(input.sourceKind === "commit" ? {} : { sourceKind: input.sourceKind }),
      metadataOnly: true,
      ...(input.baseRef === null ? {} : { baseRef: input.baseRef }),
    });
    const source = preview.sources.find((source) => source.kind === input.sourceKind);
    return yield* git.getReviewDiffFileContents({
      ...input,
      cwd: repository.cwd,
      oldPath: input.oldPath.slice(repository.prefix.length),
      newPath: input.newPath.slice(repository.prefix.length),
      baseRef: source?.baseRef ?? input.baseRef,
      headRef: source?.headRef ?? input.headRef,
    });
  });

  return ReviewService.of({
    getBranchCommits,
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
