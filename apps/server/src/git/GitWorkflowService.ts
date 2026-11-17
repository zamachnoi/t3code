import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeWorkspaceRepositories } from "../vcs/workspaceRepositories.ts";
import { makeWorkspaceWorktrees } from "./workspaceWorktrees.ts";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly repositoryRoot: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitLocalStatusOptions,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly upstreamDivergence: (cwd: string) => Effect.Effect<
      {
        readonly refName: string;
        readonly aheadCount: number;
        readonly behindCount: number;
      } | null,
      GitManagerServiceError
    >;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly readRefSnapshot: (cwd: string) => Effect.Effect<string | null>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    /** The checkout's own HEAD file, inside a linked worktree's admin directory when there is one. */
    readonly headPaths: (cwd: string) => Effect.Effect<ReadonlyArray<string>, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly remote?: GitVcsDriver.GitWorktreeBaseRemote;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listRepositories = yield* makeWorkspaceRepositories;
  const workspaceWorktrees = yield* makeWorkspaceWorktrees;
  const repositoriesForCommand = Effect.fn("GitWorkflowService.repositoriesForCommand")(function (
    cwd: string,
  ) {
    return listRepositories(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitWorkflowService.repositories",
            command: "vcs-route",
            cwd,
            detail: "Could not discover project repositories.",
            cause,
          }),
      ),
    );
  });
  const localStatus: GitWorkflowService["Service"]["localStatus"] = Effect.fn(
    "GitWorkflowService.localStatus",
  )(function* (input, options) {
    const repositories = yield* listRepositories(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "GitWorkflowService.localStatus",
            cwd: input.cwd,
            detail: "Could not discover project repositories.",
            cause,
          }),
      ),
    );
    if (repositories.length === 0) return nonRepositoryLocalStatus();
    if (repositories[0]?.prefix === "") return yield* gitManager.localStatus(input, options);
    const statuses = yield* Effect.forEach(repositories, (repo) =>
      gitManager.localStatus({ cwd: repo.cwd }, options),
    );
    const files = statuses.flatMap((status, index) =>
      status.workingTree.files.map((file) => ({
        ...file,
        path: repositories[index]!.prefix + file.path,
      })),
    );
    const branches = statuses.map((status) => status.refName);
    return {
      isRepo: true,
      repositoryPaths: repositories.map((repo) => repo.prefix.slice(0, -1)),
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: branches.every((branch) => branch === branches[0]) ? branches[0]! : null,
      hasWorkingTreeChanges: statuses.some((status) => status.hasWorkingTreeChanges),
      workingTree: {
        rootPath: input.cwd,
        files,
        insertions: statuses.reduce((sum, status) => sum + status.workingTree.insertions, 0),
        deletions: statuses.reduce((sum, status) => sum + status.workingTree.deletions, 0),
      },
      branchChanges: {
        baseRef: null,
        insertions: statuses.reduce(
          (sum, status) => sum + (status.branchChanges?.insertions ?? 0),
          0,
        ),
        deletions: statuses.reduce(
          (sum, status) => sum + (status.branchChanges?.deletions ?? 0),
          0,
        ),
      },
    };
  });

  const readCurrentBranch = Effect.fn("GitWorkflowService.readCurrentBranch")(function* (
    cwd: string,
  ) {
    const result = yield* git.execute({
      operation: "GitWorkflowService.currentBranch",
      cwd,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0) {
      return result.stdout.trim().replace(/^refs\/heads\//, "") || null;
    }
    if (result.exitCode === 1) return null;
    return yield* new GitCommandError({
      operation: "GitWorkflowService.currentBranch",
      command: "git symbolic-ref",
      cwd,
      argumentCount: 3,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      detail: "Failed to read the checked-out branch.",
    });
  });

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const repositories = yield* repositoriesForCommand(cwd);
    if (repositories.length > 0 && repositories[0]?.prefix !== "")
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: "Choose an individual repository for this Git action.",
      });
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const repositories = yield* repositoriesForCommand(cwd);
    if (repositories.length > 0 && repositories[0]?.prefix !== "")
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: "Choose an individual repository for this Git action.",
      });
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    return handle;
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const repositories = yield* listRepositories(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      return repositories[0]?.prefix === "";
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const repositories = yield* listRepositories(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    return repositories[0]?.prefix === "";
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    repositoryRoot: Effect.fn("GitWorkflowService.repositoryRoot")(function* (cwd) {
      const repositories = yield* listRepositories(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.repositoryRoot",
              cwd,
              detail: "Could not discover project repositories.",
              cause,
            }),
        ),
      );
      if (repositories[0]?.prefix !== "" && repositories.length > 0) return cwd;
      return yield* registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.repository.rootPath ?? null),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.repositoryRoot",
              cwd,
              detail: "Could not detect repository root.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function* (input) {
      const repositories = yield* repositoriesForCommand(input.cwd);
      if (repositories.length === 0) return false;
      let found = false;
      for (const repo of repositories) {
        const result = yield* git.execute({
          operation: "GitWorkflowService.hasCommit",
          cwd: repo.cwd,
          args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
          allowNonZeroExit: true,
        });
        if (input.refName.startsWith("refs/heads/")) found ||= result.exitCode === 0;
        else if (result.exitCode !== 0) return false;
      }
      return input.refName.startsWith("refs/heads/") ? found : true;
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    status: Effect.fn("GitWorkflowService.status")(function* (input) {
      if (yield* detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd))
        return yield* gitManager.status(input);
      return { ...nonRepositoryStatus(), ...(yield* localStatus(input)) };
    }),
    localStatus,
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      const repositories = yield* repositoriesForCommand(cwd);
      const branches = yield* Effect.forEach(repositories, (repository) =>
        readCurrentBranch(repository.cwd),
      );
      return branches.length > 0 && branches.every((branch) => branch === branches[0])
        ? branches[0]!
        : null;
    }),
    upstreamDivergence: Effect.fn("GitWorkflowService.upstreamDivergence")(function* (cwd) {
      const details = yield* git.statusDetailsRemote(cwd, { refreshUpstream: false });
      return details.hasUpstream && details.branch !== null
        ? {
            refName: details.branch,
            aheadCount: details.aheadCount,
            behindCount: details.behindCount,
          }
        : null;
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    readRefSnapshot: Effect.fn("GitWorkflowService.readRefSnapshot")(function (cwd) {
      return listRepositories(cwd).pipe(
        Effect.flatMap((repositories) =>
          Effect.forEach(repositories, (repo) =>
            git
              .readRefSnapshot(repo.cwd)
              .pipe(Effect.map((snapshot) => `${repo.prefix}:${snapshot ?? ""}`)),
          ),
        ),
        Effect.map((snapshots) => (snapshots.length === 0 ? null : snapshots.join("\0"))),
        Effect.orElseSucceed(() => null),
      );
    }),
    invalidateStatus: gitManager.invalidateStatus,
    headPaths: Effect.fn("GitWorkflowService.headPaths")(function (cwd) {
      return listRepositories(cwd).pipe(
        Effect.flatMap((repositories) =>
          Effect.forEach(repositories, (repo) =>
            git
              .execute({
                operation: "GitWorkflowService.headPaths",
                cwd: repo.cwd,
                args: ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
                allowNonZeroExit: true,
              })
              .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : ""))),
          ),
        ),
        Effect.map((paths) => paths.filter((path) => path !== "")),
        Effect.orElseSucceed(() => []),
      );
    }),
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      );
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function (input, options) {
      return ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitManager.runStackedAction(input, options),
          ),
        ),
      );
    }),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function (input) {
        return ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function* (input) {
      if (yield* detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd))
        return yield* git.listRefs(input);
      const repositories = yield* repositoriesForCommand(input.cwd);
      if (repositories.length === 0) return nonRepositoryListRefs();
      const refs = [{ name: "HEAD", current: true, isDefault: true, worktreePath: null }];
      return {
        isRepo: true,
        repositoryPaths: repositories.map((repo) => repo.prefix.slice(0, -1)),
        isAtRepositoryRoot: true,
        hasPrimaryRemote: false,
        refs: input.query && !"HEAD".toLowerCase().includes(input.query.toLowerCase()) ? [] : refs,
        nextCursor: null,
        totalCount: 1,
      };
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function* (input, options) {
      const repositories = yield* repositoriesForCommand(input.cwd);
      return repositories[0]?.prefix === ""
        ? yield* gitManager.createWorktree(input, options)
        : yield* workspaceWorktrees.create(input, options);
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function* (cwd) {
      const repositories = yield* repositoriesForCommand(cwd);
      const branches = yield* Effect.forEach(repositories, (repo) =>
        git.listLocalBranchNames(repo.cwd),
      );
      return [...new Set(branches.flat())];
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolvePrimaryRemoteName: Effect.fn("GitWorkflowService.resolvePrimaryRemoteName")(
      function (cwd) {
        return ensureGitCommand("GitWorkflowService.resolvePrimaryRemoteName", cwd).pipe(
          Effect.andThen(git.resolvePrimaryRemoteName(cwd)),
        );
      },
    ),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function* (input) {
        const repositories = yield* repositoriesForCommand(input.cwd);
        return repositories[0]?.prefix === "" ? yield* git.resolveWorktreeBaseRemote(input) : null;
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function* (input) {
        const repositories = yield* repositoriesForCommand(input.cwd);
        return repositories[0]?.prefix === "" ? yield* git.fetchWorktreeBaseCommit(input) : null;
      },
    ),
    resolveDefaultBranchName: Effect.fn("GitWorkflowService.resolveDefaultBranchName")(
      function (cwd, remoteName) {
        return ensureGitCommand("GitWorkflowService.resolveDefaultBranchName", cwd).pipe(
          Effect.andThen(git.resolveDefaultBranchName(cwd, remoteName)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function* (input) {
      if (
        yield* fileSystem
          .exists(path.resolve(input.cwd, input.path, ".t3-workspace.json"))
          .pipe(Effect.orElseSucceed(() => false))
      )
        return yield* workspaceWorktrees.remove(input);
      yield* ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd);
      return yield* git.removeWorktree(input);
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function* (input) {
      for (const repo of yield* repositoriesForCommand(input.cwd))
        yield* git.pruneWorktrees({ cwd: repo.cwd });
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function* (input) {
      for (const repo of yield* repositoriesForCommand(input.cwd))
        yield* git.deleteLocalBranch({ ...input, cwd: repo.cwd });
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function* (input) {
      const repositories = yield* repositoriesForCommand(input.cwd);
      if (repositories[0]?.prefix === "") return yield* git.renameBranch(input);
      if (repositories.length === 0) {
        yield* ensureGit("GitWorkflowService.renameBranch", input.cwd);
      }
      return yield* withCheckoutLease(
        input.cwd,
        Effect.gen(function* () {
          let branch = input.newBranch;
          if (!input.exactName) {
            const names = (yield* Effect.forEach(repositories, (repo) =>
              git.listLocalBranchNames(repo.cwd),
            ))
              .flat()
              .map((name) => name.toLowerCase());
            const segments = branch.split("/");
            if (
              segments.some(
                (_, index) =>
                  index > 0 && names.includes(segments.slice(0, index).join("/").toLowerCase()),
              )
            )
              branch = segments.join("-");
            const base = branch;
            for (
              let suffix = 1;
              names.some(
                (name) =>
                  name === branch.toLowerCase() || name.startsWith(`${branch.toLowerCase()}/`),
              );
              suffix++
            )
              branch = `${base}-${suffix}`;
          }
          const renamed: string[] = [];
          yield* Effect.forEach(
            repositories,
            (repo) =>
              git
                .renameBranch({ ...input, cwd: repo.cwd, newBranch: branch, exactName: true })
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      renamed.push(repo.cwd);
                    }),
                  ),
                ),
            { discard: true },
          ).pipe(
            Effect.onError(() =>
              Effect.forEach(
                renamed.toReversed(),
                (cwd) =>
                  git
                    .renameBranch({
                      cwd,
                      oldBranch: branch,
                      newBranch: input.oldBranch,
                      exactName: true,
                    })
                    .pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Could not roll back a workspace branch rename", {
                          cause,
                        }),
                      ),
                    ),
                { discard: true },
              ),
            ),
          );
          return { branch };
        }),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
