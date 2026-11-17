import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect("creates one workspace from child HEADs and refuses dirty group removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-multi-repo-" });
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.git", cwd, args });
      for (const [name, branch] of [
        ["api", "main"],
        ["web", "trunk"],
      ]) {
        const repo = `${cwd}/${name}`;
        yield* fs.makeDirectory(repo);
        yield* run(repo, ["init", "-b", branch!]);
        yield* fs.writeFileString(`${repo}/same.txt`, `${name}\n`);
        yield* run(repo, ["add", "."]);
        yield* run(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
      }
      yield* fs.writeFileString(`${cwd}/api/same.txt`, "source edits\n");
      const workflow = yield* GitWorkflowService.make.pipe(
        Effect.provide(
          Layer.mock(GitManager.GitManager)({ createWorktree: driver.createWorktree }),
        ),
      );
      assert.strictEqual(yield* workflow.repositoryRoot(cwd), cwd);
      assert.deepEqual(
        (yield* workflow.listRefs({ cwd })).refs.map((ref) => ref.name),
        ["HEAD"],
      );
      const enclosing = yield* fs.makeTempDirectoryScoped({ prefix: "t3-enclosing-repo-" });
      yield* run(enclosing, ["init", "-b", "enclosing"]);
      const output = `${enclosing}/bundle`;
      const result = yield* workflow.createWorktree({
        cwd,
        refName: "HEAD",
        newRefName: "feature/group",
        path: output,
      });
      assert.strictEqual(yield* workflow.currentBranch(result.worktree.path), "feature/group");
      assert.strictEqual((yield* workflow.headPaths(result.worktree.path)).length, 2);
      const parentAction = yield* workflow
        .runStackedAction({
          cwd: result.worktree.path,
          actionId: "test-parent-action",
          action: "commit",
        })
        .pipe(Effect.flip);
      assert.strictEqual(parentAction._tag, "GitManagerError");
      for (const name of ["api", "web"]) {
        assert.strictEqual(
          (yield* run(`${result.worktree.path}/${name}`, [
            "branch",
            "--show-current",
          ])).stdout.trim(),
          "feature/group",
        );
        assert.strictEqual(
          yield* fs.readFileString(`${result.worktree.path}/${name}/same.txt`),
          `${name}\n`,
        );
      }
      yield* run(`${cwd}/web`, ["branch", "renamed"]);
      const renamed = yield* workflow.renameBranch({
        cwd: result.worktree.path,
        oldBranch: "feature/group",
        newBranch: "renamed",
      });
      assert.strictEqual(renamed.branch, "renamed-1");
      for (const name of ["api", "web"])
        assert.strictEqual(
          (yield* run(`${result.worktree.path}/${name}`, [
            "branch",
            "--show-current",
          ])).stdout.trim(),
          "renamed-1",
        );
      yield* fs.writeFileString(`${result.worktree.path}/web/untracked.txt`, "keep me\n");
      const refused = yield* workflow
        .removeWorktree({ cwd, path: result.worktree.path })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "GitCommandError");
      assert.strictEqual(yield* fs.exists(`${result.worktree.path}/api/.git`), true);
      yield* workflow.removeWorktree({ cwd, path: result.worktree.path, force: true });
      assert.strictEqual(yield* fs.exists(result.worktree.path), false);
      for (const name of ["api", "web"])
        assert.strictEqual((yield* driver.listWorktreePaths(`${cwd}/${name}`)).length, 1);
      assert.strictEqual(yield* fs.readFileString(`${cwd}/api/same.txt`), "source edits\n");
      yield* fs.makeDirectory(`${cwd}/hooks`);
      yield* fs.writeFileString(`${cwd}/hooks/post-checkout`, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(`${cwd}/hooks/post-checkout`, 0o755);
      yield* run(`${cwd}/web`, ["config", "core.hooksPath", `${cwd}/hooks`]);
      const failed = yield* workflow
        .createWorktree({
          cwd,
          refName: "HEAD",
          newRefName: "feature/failed",
          path: `${cwd}/failed`,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "GitCommandError");
      assert.strictEqual(yield* fs.exists(`${cwd}/failed`), false);
      for (const name of ["api", "web"]) {
        assert.strictEqual((yield* driver.listWorktreePaths(`${cwd}/${name}`)).length, 1);
        assert.strictEqual(
          (yield* driver.listLocalBranchNames(`${cwd}/${name}`)).includes("feature/failed"),
          false,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(GitVcsDriver.layer, VcsDriverRegistry.layer).pipe(
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-multi-repo-worktree-" }),
          ),
          Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest({})),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(ServerSettings.ServerSettingsService.layerTest({})),
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
              detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
