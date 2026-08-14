import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  classifyUnityCompileFailure,
  classifyUnityInfrastructureFailure,
  findUnityEditor,
  parseUnityTestFailureCount,
  readUnityVersion,
  UnityValidationRunner,
} from "./unity-validation.js";
import { redactRemoteUrl } from "./unity-validation-source-tools.js";

const root = mkdtempSync(join(tmpdir(), "devspace-unity-validation-test-"));
const repository = join(root, "repo");
const editorRoot = join(root, "editors");
const stateDir = join(root, "state");
const version = "6000.5.4f1";
const editor = join(editorRoot, version, "Editor", "Unity");

const unityProject = join(repository, "UnityProject");
mkdirSync(join(unityProject, "ProjectSettings"), { recursive: true });
writeFileSync(join(unityProject, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
writeFileSync(
  join(repository, ".unity-validation.json"),
  JSON.stringify(
    {
      schema: 1,
      projectPath: "UnityProject",
      profiles: {
        ci: {
          compile: true,
          editModeTests: true,
          playModeTests: true,
          validators: ["Example.Validation.Run"],
          build: {
            target: "StandaloneLinux64",
            executeMethod: "Example.Build.Run",
          },
        },
      },
    },
    null,
    2,
  ) + "\n",
);

mkdirSync(join(editorRoot, version, "Editor"), { recursive: true });
writeFileSync(
  editor,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const project = value("-projectPath");
const cache = project ? path.join(project, "Library", "fake-cache.txt") : undefined;
const cacheReused = cache ? fs.existsSync(cache) : false;
if (cache) { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, "cached\\n"); }
const log = value("-logFile");
if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, "fake unity success cache=" + (cacheReused ? "reused" : "created") + "\\n"); }
const result = value("-testResults");
if (result) { fs.mkdirSync(path.dirname(result), { recursive: true }); fs.writeFileSync(result, '<test-run total="1" passed="1" failed="0" />\\n'); }
process.exit(0);
`,
);
chmodSync(editor, 0o755);

execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
execFileSync("git", ["config", "user.name", "DevSpace Test"], { cwd: repository });
execFileSync("git", ["config", "user.email", "devspace@example.invalid"], { cwd: repository });
execFileSync("git", ["add", "."], { cwd: repository });
execFileSync("git", ["commit", "-m", "test project"], { cwd: repository, stdio: "ignore" });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

assert.equal(await readUnityVersion(unityProject), version);
assert.equal(await findUnityEditor(version, [editorRoot]), editor);
assert.equal(classifyUnityInfrastructureFailure("No valid Unity Editor license"), "UNITY_LICENSE_FAILURE");
assert.equal(classifyUnityInfrastructureFailure("write failed: No space left on device"), "DISK_FULL");
assert.equal(classifyUnityInfrastructureFailure("Assets imported successfully"), undefined);
assert.equal(classifyUnityCompileFailure("Assets/Foo.cs(1,1): error CS1002: ; expected"), "UNITY_COMPILATION_FAILED");
assert.equal(classifyUnityCompileFailure("Compilation finished successfully"), undefined);
assert.equal(parseUnityTestFailureCount('<test-run total="3" passed="2" failed="1" />'), 1);
assert.equal(parseUnityTestFailureCount('<test-run><test-case result="Failed" /><test-case result="Passed" /></test-run>'), 1);
assert.equal(parseUnityTestFailureCount("<test-run>truncated"), undefined);
assert.deepEqual(redactRemoteUrl("https://user:secret@example.com/org/repo.git"), {
  repositoryUrl: "https://example.com/org/repo.git",
  credentialsRedacted: true,
});
assert.deepEqual(redactRemoteUrl("git@example.com:org/repo.git"), {
  repositoryUrl: "example.com:org/repo.git",
  credentialsRedacted: true,
});
assert.deepEqual(redactRemoteUrl("ssh://token@example.com/org/repo.git"), {
  repositoryUrl: "ssh://example.com/org/repo.git",
  credentialsRedacted: true,
});

const runner = new UnityValidationRunner({
  enabled: true,
  stateDir,
  editorRoots: [editorRoot],
  maxConcurrentJobs: 2,
  jobTimeoutSeconds: 30,
  allowedRepositoryPrefixes: [root],
}, { allowLocalRepositoriesForTests: true });

await assert.rejects(
  () => runner.submit({ repositoryUrl: repository, commit: "main" }),
  /immutable hexadecimal Git commit SHA/,
);
await assert.rejects(
  () => runner.submit({ repositoryUrl: "https://example.com/not-allowed.git", commit }),
  /Repository is not allowed/,
);
await assert.rejects(
  () => runner.submit({ repositoryUrl: "file:///tmp/repo", commit }),
  /credential-free HTTPS or SSH/,
);
await assert.rejects(
  () => runner.submit({ repositoryUrl: "ext::sh -c evil", commit }),
  /credential-free HTTPS or SSH/,
);
await assert.rejects(
  () => runner.submit({ repositoryUrl: "-c", commit }),
  /option-like/,
);
await assert.rejects(
  () => runner.submit({ repositoryUrl: "https://token@example.com/org/repo.git", commit }),
  /must not contain embedded credentials/,
);

const first = await runner.submit({ repositoryUrl: repository, commit, profile: "ci" });
const second = await runner.submit({ repositoryUrl: repository, commit, profile: "compile" });
const [firstResult, secondResult] = await Promise.all([
  waitForTerminal(runner, first.jobId),
  waitForTerminal(runner, second.jobId),
]);

assert.equal(firstResult.status, "passed", JSON.stringify(firstResult, null, 2));
assert.equal(firstResult.validatedCommit, commit);
assert.equal(firstResult.unityVersion, version);
assert.deepEqual(firstResult.steps.map((step) => step.name), [
  "compile",
  "editmode",
  "playmode",
  "validator-1",
  "build",
]);
assert.equal(secondResult.status, "passed", JSON.stringify(secondResult, null, 2));
assert.equal(secondResult.validatedCommit, commit);
assert.deepEqual(secondResult.steps.map((step) => step.name), ["compile"]);
assert.match(await runner.readArtifact(first.jobId, "compile.log"), /fake unity success/);
assert.match(await runner.readArtifact(first.jobId, "editmode-results.xml"), /passed="1"/);
const third = await runner.submit({ repositoryUrl: repository, commit, profile: "compile" });
const thirdResult = await waitForTerminal(runner, third.jobId);
assert.equal(thirdResult.status, "passed", JSON.stringify(thirdResult, null, 2));
assert.equal(thirdResult.slot, 0);
assert.match(await runner.readArtifact(third.jobId, "compile.log"), /cache=reused/);

const normalEditorSource = readFileSync(editor, "utf8");
writeFileSync(
  editor,
  normalEditorSource.replace(
    '<test-run total="1" passed="1" failed="0" />\\n',
    '<test-run>truncated\\n',
  ),
);
const malformed = await runner.submit({ repositoryUrl: repository, commit, profile: "test" });
const malformedResult = await waitForTerminal(runner, malformed.jobId);
assert.equal(malformedResult.status, "failed", JSON.stringify(malformedResult, null, 2));
assert.equal(malformedResult.failureCategory, "TEST_FAILURE");
assert.equal(malformedResult.failureCode, "TEST_RESULTS_UNPARSEABLE");

writeFileSync(
  editor,
  `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 5000);\n`,
);
chmodSync(editor, 0o755);
const cancelled = await runner.submit({ repositoryUrl: repository, commit, profile: "compile" });
await waitForStatus(runner, cancelled.jobId, "running");
await runner.cancel(cancelled.jobId);
const cancelledResult = await waitForTerminal(runner, cancelled.jobId);
assert.equal(cancelledResult.status, "cancelled", JSON.stringify(cancelledResult, null, 2));
await waitForIdle(runner);

writeFileSync(join(repository, ".unity-validation.json"), "{ invalid json\n");
execFileSync("git", ["add", ".unity-validation.json"], { cwd: repository });
execFileSync("git", ["commit", "-m", "invalid validation config"], { cwd: repository, stdio: "ignore" });
const invalidConfigCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const invalidConfig = await runner.submit({
  repositoryUrl: repository,
  commit: invalidConfigCommit,
  profile: "compile",
});
const invalidConfigResult = await waitForTerminal(runner, invalidConfig.jobId);
assert.equal(invalidConfigResult.status, "failed", JSON.stringify(invalidConfigResult, null, 2));
assert.equal(invalidConfigResult.failureCategory, "VALIDATION_FAILURE");
assert.equal(invalidConfigResult.failureCode, "INVALID_VALIDATION_CONFIG");
await waitForIdle(runner);

assert.equal(runner.health().activeJobs, 0);
assert.equal(runner.health().queuedJobs, 0);
await runner.shutdown();

const restoredRunner = new UnityValidationRunner({
  enabled: true,
  stateDir,
  editorRoots: [editorRoot],
  maxConcurrentJobs: 2,
  jobTimeoutSeconds: 30,
  allowedRepositoryPrefixes: [root],
}, { allowLocalRepositoriesForTests: true });
assert.equal(restoredRunner.get(first.jobId).status, "passed");
assert.equal(restoredRunner.get(first.jobId).validatedCommit, commit);
assert.match(await restoredRunner.readArtifact(first.jobId, "compile.log"), /fake unity success/);
await restoredRunner.shutdown();

async function waitForIdle(runner: UnityValidationRunner) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const health = runner.health();
    if (health.activeJobs === 0 && health.queuedJobs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for runner to become idle: ${JSON.stringify(runner.health())}`);
}

async function waitForStatus(
  runner: UnityValidationRunner,
  jobId: string,
  status: "queued" | "running" | "passed" | "failed" | "cancelled",
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = runner.get(jobId);
    if (summary.status === status) return summary;
    if (["passed", "failed", "cancelled"].includes(summary.status)) {
      throw new Error(`Job ${jobId} reached ${summary.status} before ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} to reach ${status}.`);
}

async function waitForTerminal(runner: UnityValidationRunner, jobId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = runner.get(jobId);
    if (["passed", "failed", "cancelled"].includes(summary.status)) return summary;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId}: ${JSON.stringify(runner.get(jobId), null, 2)}`);
}
