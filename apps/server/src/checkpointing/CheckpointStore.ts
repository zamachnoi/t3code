import { type CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import { makeWorkspaceRepositories } from "../vcs/workspaceRepositories.ts";
import { prefixNumstat } from "../vcs/workspaceDiff.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const listRepositories = yield* makeWorkspaceRepositories;
  const resolveRepositories = Effect.fn("CheckpointStore.resolveRepositories")(function* (
    cwd: string,
  ) {
    const repositories = yield* listRepositories(cwd, { strict: true });
    if (repositories.length === 0) yield* vcsRegistry.resolve({ cwd });
    return yield* Effect.forEach(repositories, (repository) =>
      vcsRegistry
        .resolve({ cwd: repository.cwd })
        .pipe(Effect.map((handle) => ({ ...repository, checkpoints: handle.driver.checkpoints }))),
    );
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = Effect.fn(
    "CheckpointStore.isGitRepository",
  )(function* (cwd) {
    return (yield* listRepositories(cwd, { strict: true })).length > 0;
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    for (const repository of yield* resolveRepositories(input.cwd)) {
      yield* repository.checkpoints.captureCheckpoint({ ...input, cwd: repository.cwd });
    }
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const repositories = yield* resolveRepositories(input.cwd);
    for (const repository of repositories) {
      if (!(yield* repository.checkpoints.hasCheckpointRef({ ...input, cwd: repository.cwd })))
        return false;
    }
    return repositories.length > 0;
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const repositories = yield* resolveRepositories(input.cwd);
    // Refuse before restoring any files when one repository has no snapshot.
    if (!input.fallbackToHead && !(yield* hasCheckpointRef(input))) return false;
    let restored = true;
    for (const repository of repositories) {
      restored =
        (yield* repository.checkpoints.restoreCheckpoint({ ...input, cwd: repository.cwd })) &&
        restored;
    }
    return restored;
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    let diff = "";
    for (const repository of yield* resolveRepositories(input.cwd)) {
      const filePaths = input.filePaths
        ?.filter((file) => file.startsWith(repository.prefix))
        .map((file) => file.slice(repository.prefix.length));
      const output = yield* repository.checkpoints.diffCheckpoints({
        ...input,
        cwd: repository.cwd,
        pathPrefix: repository.prefix,
        ...(filePaths === undefined ? {} : { filePaths }),
      });
      diff += input.format === "numstat" ? prefixNumstat(output, repository.prefix) : output;
    }
    return diff;
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const repositories = yield* resolveRepositories(input.cwd);
    const authored = new Set<string>();
    for (const repository of repositories) {
      const paths = yield* repository.checkpoints.listAuthoredPaths({
        ...input,
        cwd: repository.cwd,
      });
      if (paths === null && repository.prefix === "") return null;
      const files =
        paths ??
        new Set(
          parseTurnDiffFilesFromNumstat(
            yield* repository.checkpoints.diffCheckpoints({
              ...input,
              cwd: repository.cwd,
              ignoreWhitespace: false,
              format: "numstat",
            }),
          ).flatMap((file) => (file.previousPath ? [file.path, file.previousPath] : [file.path])),
        );
      for (const file of files) authored.add(repository.prefix + file);
    }
    return authored;
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    for (const repository of yield* resolveRepositories(input.cwd)) {
      yield* repository.checkpoints.deleteCheckpointRefs({ ...input, cwd: repository.cwd });
    }
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
