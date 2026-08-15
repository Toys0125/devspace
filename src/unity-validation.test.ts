import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildUnityEditorInvocation,
  buildUnitySharedCacheEnvironment,
  classifyUnityCompileFailure,
  classifyUnityInfrastructureFailure,
  extractUnityPersonalSerial,
  findUnityEditor,
  parseUnityTestFailureCount,
  readUnityEditorIdentity,
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
const changeset = "0123456789abcdef0123456789abcdef01234567";
writeFileSync(
  join(unityProject, "ProjectSettings", "ProjectVersion.txt"),
  `m_EditorVersion: ${version}\nm_EditorVersionWithRevision: ${version} (${changeset})\n`,
);
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
assert.deepEqual(await readUnityEditorIdentity(unityProject), { version, changeset });
assert.equal(await findUnityEditor(version, [editorRoot]), editor);
assert.deepEqual(buildUnityEditorInvocation(editor, ["-batchmode"], undefined), {
  command: editor,
  args: ["-batchmode"],
});
assert.deepEqual(buildUnityEditorInvocation(editor, ["-batchmode"], "xvfb-run"), {
  command: "xvfb-run",
  args: ["-a", "--server-args=-screen 0 640x480x24", editor, "-batchmode"],
});
assert.equal(classifyUnityInfrastructureFailure("No valid Unity Editor license"), "UNITY_LICENSE_FAILURE");
assert.equal(classifyUnityInfrastructureFailure("Legacy MachineBinding validation failed"), "UNITY_LICENSE_FAILURE");
assert.equal(classifyUnityInfrastructureFailure("Successfully connected to LicensingClient"), undefined);
assert.equal(classifyUnityInfrastructureFailure("Access token is unavailable; failed to update"), undefined);
assert.equal(classifyUnityInfrastructureFailure("Error: spawn xvfb-run ENOENT"), "UNITY_XVFB_MISSING");
assert.equal(classifyUnityInfrastructureFailure("write failed: No space left on device"), "DISK_FULL");
assert.equal(classifyUnityInfrastructureFailure("Assets imported successfully"), undefined);
assert.equal(classifyUnityCompileFailure("Assets/Foo.cs(1,1): error CS1002: ; expected"), "UNITY_COMPILATION_FAILED");
assert.equal(classifyUnityCompileFailure("Compilation finished successfully"), undefined);
assert.equal(parseUnityTestFailureCount('<test-run total="3" passed="2" failed="1" />'), 1);
assert.equal(parseUnityTestFailureCount('<test-run><test-case result="Failed" /><test-case result="Passed" /></test-run>'), 1);
assert.equal(parseUnityTestFailureCount("<test-run>truncated"), undefined);
const sharedCacheEnv = buildUnitySharedCacheEnvironment("/cache/unity/upm", { HOME: "/root" });
assert.equal(sharedCacheEnv?.HOME, "/root");
assert.equal(sharedCacheEnv?.UPM_CACHE_ROOT, "/cache/unity/upm");
assert.equal(sharedCacheEnv?.UPM_ENABLE_GIT_LFS_CACHE, "1");
assert.equal(sharedCacheEnv?.UPM_GIT_LFS_CACHE_PATH, "/cache/unity/upm/git-lfs");
assert.equal(buildUnitySharedCacheEnvironment(undefined, { HOME: "/root" }), undefined);
const syntheticPersonalSerial = "F4-ABCD-EFGH-IJKL-MNOP-QRST";
const developerData = Buffer.from(`junk${syntheticPersonalSerial}`, "latin1").toString("base64");
assert.equal(extractUnityPersonalSerial(`<DeveloperData Value="${developerData}"/>`), syntheticPersonalSerial);
assert.throws(() => extractUnityPersonalSerial("<root />"), /DeveloperData/);
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
  autoInstallEditors: false,
  editorInstallTimeoutSeconds: 30,
  editorInstaller: "unity-cli",
  unityCliExecutable: "unity",
  unityHubExecutable: "unityhub",
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
  normalEditorSource
    .replace(
      '<test-run total="1" passed="1" failed="0" />\\n',
      '<test-run total="3" passed="1" failed="2" />\\n',
    )
    .replace("process.exit(0);", 'process.exit(args.includes("-runTests") ? 2 : 0);'),
);
const failedTests = await runner.submit({ repositoryUrl: repository, commit, profile: "test" });
const failedTestsResult = await waitForTerminal(runner, failedTests.jobId);
assert.equal(failedTestsResult.status, "failed", JSON.stringify(failedTestsResult, null, 2));
assert.equal(failedTestsResult.failureCategory, "TEST_FAILURE");
assert.equal(failedTestsResult.failureCode, "TESTS_FAILED");
assert.match(failedTestsResult.message ?? "", /2 Unity tests failed/);

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

const autoRepository = join(root, "auto-repo");
const autoEditorRoot = join(root, "auto-editors");
const autoStateDir = join(root, "auto-state");
const autoVersion = "6000.5.7f1";
const autoChangeset = "abcdef1234567890abcdef1234567890abcdef12";
mkdirSync(join(autoRepository, "ProjectSettings"), { recursive: true });
writeFileSync(
  join(autoRepository, "ProjectSettings", "ProjectVersion.txt"),
  `m_EditorVersion: ${autoVersion}\nm_EditorVersionWithRevision: ${autoVersion} (${autoChangeset})\n`,
);
execFileSync("git", ["init"], { cwd: autoRepository, stdio: "ignore" });
execFileSync("git", ["config", "user.name", "DevSpace Test"], { cwd: autoRepository });
execFileSync("git", ["config", "user.email", "devspace@example.invalid"], { cwd: autoRepository });
execFileSync("git", ["add", "."], { cwd: autoRepository });
execFileSync("git", ["commit", "-m", "auto install project"], { cwd: autoRepository, stdio: "ignore" });
const autoCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: autoRepository, encoding: "utf8" }).trim();

const fakeUnityCli = join(root, "fake-unity-cli");
const installCountPath = join(root, "fake-unity-cli-install-count.txt");
writeFileSync(
  fakeUnityCli,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const installRoot = ${JSON.stringify(autoEditorRoot)};
const countPath = ${JSON.stringify(installCountPath)};
const expectedChangeset = ${JSON.stringify(autoChangeset)};
if (!args.includes("--non-interactive")) process.exit(4);
if (args.includes("--no-pager")) process.exit(5);
if (args.includes("install-path")) process.exit(0);
if (!args.includes("install") || !args.includes("--yes")) process.exit(2);
const installIndex = args.indexOf("install");
const changesetIndex = args.indexOf("--changeset");
const requestedVersion = installIndex >= 0 ? args[installIndex + 1] : undefined;
const requestedChangeset = changesetIndex >= 0 ? args[changesetIndex + 1] : undefined;
if (!requestedVersion || requestedChangeset !== expectedChangeset) process.exit(3);
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
fs.writeFileSync(countPath, String(count + 1));
console.log("fake unity cli install " + requestedVersion + " " + requestedChangeset);
setTimeout(() => {
  const editor = path.join(installRoot, requestedVersion, "Editor", "Unity");
  fs.mkdirSync(path.dirname(editor), { recursive: true });
  fs.writeFileSync(editor, '#!/usr/bin/env node\\nconst fs=require("node:fs");\\nconst args=process.argv.slice(2);\\nconst i=args.indexOf("-logFile");\\nif(i>=0){fs.mkdirSync(require("node:path").dirname(args[i+1]),{recursive:true});fs.writeFileSync(args[i+1],"auto-installed unity success\\\\n");}\\nprocess.exit(0);\\n');
  fs.chmodSync(editor, 0o755);
  process.exit(0);
}, 250);
`,
);
chmodSync(fakeUnityCli, 0o755);

const autoRunner = new UnityValidationRunner({
  enabled: true,
  stateDir: autoStateDir,
  editorRoots: [autoEditorRoot],
  maxConcurrentJobs: 2,
  jobTimeoutSeconds: 30,
  autoInstallEditors: true,
  editorInstallTimeoutSeconds: 30,
  editorInstaller: "unity-cli",
  unityCliExecutable: fakeUnityCli,
  unityHubExecutable: "unityhub",
  allowedRepositoryPrefixes: [root],
}, { allowLocalRepositoriesForTests: true });
const autoFirst = await autoRunner.submit({ repositoryUrl: autoRepository, commit: autoCommit, profile: "compile" });
const autoSecond = await autoRunner.submit({ repositoryUrl: autoRepository, commit: autoCommit, profile: "compile" });
const [autoFirstResult, autoSecondResult] = await Promise.all([
  waitForTerminal(autoRunner, autoFirst.jobId),
  waitForTerminal(autoRunner, autoSecond.jobId),
]);
assert.equal(autoFirstResult.status, "passed", JSON.stringify(autoFirstResult, null, 2));
assert.equal(autoSecondResult.status, "passed", JSON.stringify(autoSecondResult, null, 2));
assert.equal(autoFirstResult.unityChangeset, autoChangeset);
assert.equal(autoSecondResult.unityChangeset, autoChangeset);
assert.equal(readFileSync(installCountPath, "utf8"), "1");
const installSteps = [autoFirstResult, autoSecondResult]
  .flatMap((result) => result.steps)
  .filter((step) => step.name === "editor-install");
assert.ok(installSteps.length >= 1);
assert.ok(installSteps.every((step) => step.status === "passed"));
assert.equal(autoRunner.health().autoInstallEditors, true);
await autoRunner.shutdown();

const restoredRunner = new UnityValidationRunner({
  enabled: true,
  stateDir,
  editorRoots: [editorRoot],
  maxConcurrentJobs: 2,
  jobTimeoutSeconds: 30,
  autoInstallEditors: false,
  editorInstallTimeoutSeconds: 30,
  editorInstaller: "unity-cli",
  unityCliExecutable: "unity",
  unityHubExecutable: "unityhub",
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
