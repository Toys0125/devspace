import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type UnityValidationStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export type UnityValidationFailureCategory =
  | "SOURCE_FAILURE"
  | "TEST_FAILURE"
  | "BUILD_FAILURE"
  | "VALIDATION_FAILURE"
  | "INFRASTRUCTURE_FAILURE"
  | "TIMEOUT"
  | "CANCELLED";

export type UnityEditorInstaller = "unity-cli" | "hub";

export interface UnityRunnerConfig {
  enabled: boolean;
  stateDir: string;
  editorRoots: string[];
  maxConcurrentJobs: number;
  jobTimeoutSeconds: number;
  autoInstallEditors: boolean;
  editorInstallTimeoutSeconds: number;
  editorInstaller: UnityEditorInstaller;
  unityCliExecutable: string;
  unityHubExecutable: string;
  personalLicenseFile?: string;
  personalLicenseEmailFile?: string;
  personalLicensePasswordFile?: string;
  allowedRepositoryPrefixes: string[];
}

export interface UnityValidationRequest {
  repositoryUrl: string;
  commit: string;
  profile?: string;
  projectPath?: string;
  configPath?: string;
}

export interface UnityValidationStep {
  name: string;
  status: "passed" | "failed" | "cancelled";
  durationSeconds: number;
  exitCode?: number | null;
  log?: string;
  resultFile?: string;
  failureCategory?: UnityValidationFailureCategory;
  failureCode?: string;
  message?: string;
}

export interface UnityValidationSummary {
  schema: 1;
  jobId: string;
  repositoryUrl: string;
  commit: string;
  validatedCommit?: string;
  profile: string;
  projectPath?: string;
  unityVersion?: string;
  unityChangeset?: string;
  editorPath?: string;
  status: UnityValidationStatus;
  failureCategory?: UnityValidationFailureCategory;
  failureCode?: string;
  message?: string;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  steps: UnityValidationStep[];
  artifactsDir: string;
  slot?: number;
}

interface UnityValidationProfile {
  compile?: boolean;
  editModeTests?: boolean;
  playModeTests?: boolean;
  nographics?: boolean;
  validators?: Array<string | UnityExecuteMethod>;
  build?: UnityBuildStep | boolean;
}

interface UnityExecuteMethod {
  executeMethod: string;
  args?: string[];
}

interface UnityBuildStep extends UnityExecuteMethod {
  target?: string;
}

interface UnityValidationProjectConfig {
  schema?: number;
  projectPath?: string;
  profiles?: Record<string, UnityValidationProfile>;
}

interface InternalJob {
  summary: UnityValidationSummary;
  request: Required<Pick<UnityValidationRequest, "repositoryUrl" | "commit">> &
    Omit<UnityValidationRequest, "repositoryUrl" | "commit">;
  abortController: AbortController;
  child?: ChildProcess;
}

interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface UnityEditorIdentity {
  version: string;
  changeset?: string;
}

interface UnityEditorInstallResult {
  status: "passed" | "failed" | "cancelled";
  durationSeconds: number;
  exitCode?: number | null;
  editorPath?: string;
  failureCode?: string;
  message?: string;
  sharedLogPath: string;
}

const DEFAULT_PROFILES: Record<string, UnityValidationProfile> = {
  compile: { compile: true },
  test: { compile: true, editModeTests: true },
  playmode: { compile: true, editModeTests: true, playModeTests: true },
  full: { compile: true, editModeTests: true, playModeTests: true },
};

export function defaultUnityEditorRoots(): string[] {
  return [join(homedir(), "Unity", "Hub", "Editor"), "/opt/unity/editors"];
}

interface UnityValidationRunnerOptions {
  allowLocalRepositoriesForTests?: boolean;
}

const SAFE_EXTERNAL_GIT_ARGS = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
];

export class UnityValidationRunner {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private readonly repositoryLockTails = new Map<string, Promise<void>>();
  private readonly editorInstallPromises = new Map<string, Promise<UnityEditorInstallResult>>();
  private editorInstallerTail: Promise<void> = Promise.resolve();
  private readonly editorInstallerAbortController = new AbortController();
  private readonly freeSlots: number[];
  private activeJobs = 0;
  private shuttingDown = false;
  private personalLicenseActivated = false;
  private personalLicenseActivation?: Promise<boolean>;

  constructor(
    private readonly config: UnityRunnerConfig,
    private readonly options: UnityValidationRunnerOptions = {},
  ) {
    this.freeSlots = Array.from({ length: config.maxConcurrentJobs }, (_value, index) => index);
    this.restorePersistedSummaries();
  }

  async submit(request: UnityValidationRequest): Promise<UnityValidationSummary> {
    if (!this.config.enabled) throw new Error("Unity validation runner is disabled.");
    if (this.shuttingDown) throw new Error("Unity validation runner is shutting down.");
    validateRepositoryUrl(
      request.repositoryUrl,
      this.config.allowedRepositoryPrefixes,
      this.options.allowLocalRepositoriesForTests === true,
    );
    validateCommit(request.commit);

    const jobId = `unity_${randomUUID()}`;
    const jobRoot = join(this.config.stateDir, "jobs", jobId);
    const artifactsDir = join(jobRoot, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const summary: UnityValidationSummary = {
      schema: 1,
      jobId,
      repositoryUrl: request.repositoryUrl,
      commit: request.commit,
      profile: request.profile ?? "test",
      status: "queued",
      submittedAt: new Date().toISOString(),
      steps: [],
      artifactsDir,
    };
    const job: InternalJob = {
      summary,
      request: { ...request, repositoryUrl: request.repositoryUrl, commit: request.commit },
      abortController: new AbortController(),
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    await this.persistSummary(job);
    this.schedule();
    return cloneSummary(summary);
  }

  get(jobId: string): UnityValidationSummary {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown Unity validation job: ${jobId}`);
    return cloneSummary(job.summary);
  }

  async cancel(jobId: string): Promise<UnityValidationSummary> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown Unity validation job: ${jobId}`);
    if (["passed", "failed", "cancelled"].includes(job.summary.status)) {
      return cloneSummary(job.summary);
    }

    job.abortController.abort();
    job.child?.kill("SIGTERM");
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    job.summary.status = "cancelled";
    job.summary.failureCategory = "CANCELLED";
    job.summary.failureCode = "CANCELLED";
    job.summary.message = queueIndex >= 0
      ? "Validation cancelled before execution."
      : "Validation cancelled while running.";
    job.summary.completedAt = new Date().toISOString();
    await this.persistSummary(job);
    return cloneSummary(job.summary);
  }

  async readArtifact(jobId: string, name: string, tailLines = 200): Promise<string> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown Unity validation job: ${jobId}`);
    const safeName = basename(name);
    if (safeName !== name || safeName === "." || safeName === "..") {
      throw new Error("Artifact name must be a single filename.");
    }
    const filePath = join(job.summary.artifactsDir, safeName);
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    return lines.slice(-Math.max(1, Math.min(tailLines, 2_000))).join("\n");
  }

  health(): {
    enabled: boolean;
    activeJobs: number;
    queuedJobs: number;
    maxConcurrentJobs: number;
    editorRoots: string[];
    autoInstallEditors: boolean;
    editorInstaller: UnityEditorInstaller;
    installingEditorVersions: string[];
  } {
    return {
      enabled: this.config.enabled,
      activeJobs: this.activeJobs,
      queuedJobs: this.queue.length,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      editorRoots: [...this.config.editorRoots],
      autoInstallEditors: this.config.autoInstallEditors,
      editorInstaller: this.config.editorInstaller,
      installingEditorVersions: [...this.editorInstallPromises.keys()].sort(),
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.editorInstallerAbortController.abort();
    const writes: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (job.summary.status === "queued" || job.summary.status === "running") {
        job.abortController.abort();
        job.child?.kill("SIGTERM");
        job.summary.status = "cancelled";
        job.summary.failureCategory = "CANCELLED";
        job.summary.failureCode = "SERVER_SHUTDOWN";
        job.summary.message = "Validation cancelled because the Unity validation server is shutting down.";
        job.summary.completedAt = new Date().toISOString();
        writes.push(this.persistSummary(job));
      }
    }
    await Promise.all(writes);
  }

  private restorePersistedSummaries(): void {
    const jobsDir = join(this.config.stateDir, "jobs");
    let entries: Dirent[];
    try {
      entries = readdirSync(jobsDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("unity_")) continue;
      const summaryPath = join(jobsDir, entry.name, "artifacts", "summary.json");
      try {
        const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as UnityValidationSummary;
        if (summary.schema !== 1 || summary.jobId !== entry.name) continue;
        summary.artifactsDir = join(jobsDir, entry.name, "artifacts");
        if (summary.status === "queued" || summary.status === "running") {
          summary.status = "failed";
          summary.failureCategory = "INFRASTRUCTURE_FAILURE";
          summary.failureCode = "RUNNER_RESTARTED";
          summary.message = "Validation was interrupted by a Unity validation server restart.";
          summary.completedAt = new Date().toISOString();
          writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
        }
        this.jobs.set(summary.jobId, {
          summary,
          request: {
            repositoryUrl: summary.repositoryUrl,
            commit: summary.commit,
            profile: summary.profile,
          },
          abortController: new AbortController(),
        });
      } catch {
        // Ignore corrupt or partial historical receipts; active jobs create fresh state.
      }
    }
  }

  private schedule(): void {
    while (!this.shuttingDown && this.freeSlots.length > 0 && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      const job = this.jobs.get(jobId);
      if (!job || job.summary.status !== "queued") continue;
      const slot = this.freeSlots.shift();
      if (slot === undefined) return;
      job.summary.slot = slot;
      this.activeJobs += 1;
      void this.runJob(job, slot).finally(() => {
        this.activeJobs -= 1;
        this.freeSlots.push(slot);
        this.freeSlots.sort((a, b) => a - b);
        this.schedule();
      });
    }
  }

  private async runJob(job: InternalJob, slot: number): Promise<void> {
    job.summary.status = "running";
    job.summary.startedAt = new Date().toISOString();
    await this.persistSummary(job);

    const jobRoot = resolve(this.config.stateDir, "jobs", job.summary.jobId);
    try {
      const { mirrorPath, repoKey } = await this.prepareRepository(job.request.repositoryUrl, job.summary.jobId);
      const checkoutPath = await this.prepareSlot(job, mirrorPath, repoKey, slot, jobRoot);
      if (job.summary.status !== "running") return;

      job.summary.validatedCommit = job.request.commit;
      let projectConfig: UnityValidationProjectConfig;
      let projectPath: string;
      let editorIdentity: UnityEditorIdentity;
      try {
        projectConfig = await loadProjectConfig(checkoutPath, job.request.configPath ?? ".unity-validation.json");
        projectPath = resolve(checkoutPath, job.request.projectPath ?? projectConfig.projectPath ?? ".");
        assertPathInside(projectPath, checkoutPath, "Unity project path");
        editorIdentity = await readUnityEditorIdentity(projectPath);
      } catch (error) {
        await this.fail(
          job,
          "VALIDATION_FAILURE",
          "INVALID_VALIDATION_CONFIG",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      job.summary.projectPath = projectPath;
      job.summary.unityVersion = editorIdentity.version;
      job.summary.unityChangeset = editorIdentity.changeset;
      const editorPath = await this.resolveUnityEditor(job, editorIdentity);
      if (!editorPath || job.summary.status !== "running") return;
      job.summary.editorPath = editorPath;
      if (!(await this.ensurePersonalLicense(job, editorPath))) return;

      const profileName = job.summary.profile;
      const profile = projectConfig.profiles?.[profileName] ?? DEFAULT_PROFILES[profileName];
      if (!profile) {
        await this.fail(job, "VALIDATION_FAILURE", "UNKNOWN_PROFILE", `Validation profile '${profileName}' is not defined.`);
        return;
      }

      if (profile.compile !== false) {
        const ok = await this.runUnityStep(job, editorPath, projectPath, "compile", ["-quit"], "SOURCE_FAILURE", profile.nographics !== false);
        if (!ok) return;
      }
      if (profile.editModeTests) {
        const resultFile = join(job.summary.artifactsDir, "editmode-results.xml");
        const ok = await this.runUnityStep(job, editorPath, projectPath, "editmode", ["-runTests", "-testPlatform", "editmode", "-testResults", resultFile], "TEST_FAILURE", profile.nographics !== false, resultFile);
        if (!ok) return;
      }
      if (profile.playModeTests) {
        const resultFile = join(job.summary.artifactsDir, "playmode-results.xml");
        const ok = await this.runUnityStep(job, editorPath, projectPath, "playmode", ["-runTests", "-testPlatform", "playmode", "-testResults", resultFile], "TEST_FAILURE", profile.nographics !== false, resultFile);
        if (!ok) return;
      }
      for (const [index, validator] of (profile.validators ?? []).entries()) {
        const method = typeof validator === "string" ? { executeMethod: validator } : validator;
        const ok = await this.runUnityStep(
          job,
          editorPath,
          projectPath,
          `validator-${index + 1}`,
          ["-executeMethod", method.executeMethod, ...(method.args ?? []), "-quit"],
          "VALIDATION_FAILURE",
          profile.nographics !== false,
        );
        if (!ok) return;
      }
      if (profile.build) {
        if (profile.build === true) {
          await this.fail(job, "VALIDATION_FAILURE", "BUILD_METHOD_REQUIRED", "The selected profile enables build=true but does not define build.executeMethod.");
          return;
        }
        const buildArgs = [
          ...(profile.build.target ? ["-buildTarget", profile.build.target] : []),
          "-executeMethod",
          profile.build.executeMethod,
          ...(profile.build.args ?? []),
          "-quit",
        ];
        const ok = await this.runUnityStep(job, editorPath, projectPath, "build", buildArgs, "BUILD_FAILURE", profile.nographics !== false);
        if (!ok) return;
      }

      if (job.abortController.signal.aborted || job.summary.status !== "running") {
        if (job.summary.status === "running") {
          await this.fail(job, "CANCELLED", "CANCELLED", "Validation cancelled.", "cancelled");
        }
        return;
      }
      job.summary.status = "passed";
      job.summary.completedAt = new Date().toISOString();
      job.summary.message = `Validated ${job.summary.validatedCommit} with Unity ${editorIdentity.version} using profile '${profileName}'.`;
      await this.persistSummary(job);
    } catch (error) {
      if (job.abortController.signal.aborted) {
        await this.fail(job, "CANCELLED", "CANCELLED", "Validation cancelled.", "cancelled");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const code = classifyUnityInfrastructureFailure(message)
          ?? (message.startsWith("Git mirror ") ? "GIT_FETCH_FAILURE" : "RUNNER_FAILURE");
        await this.fail(job, "INFRASTRUCTURE_FAILURE", code, message);
      }
    }
  }

  private async prepareRepository(
    repositoryUrl: string,
    jobId: string,
  ): Promise<{ mirrorPath: string; repoKey: string }> {
    const repoKey = createHash("sha256").update(repositoryUrl).digest("hex").slice(0, 24);
    return this.withRepositoryLock(repoKey, async () => {
      const mirrorsDir = join(this.config.stateDir, "mirrors");
      const mirrorPath = join(mirrorsDir, `${repoKey}.git`);
      await mkdir(mirrorsDir, { recursive: true });
      const exists = await pathExists(join(mirrorPath, "HEAD"));
      const logPath = join(this.config.stateDir, "jobs", jobId, "artifacts", "git-fetch.log");
      const externalGitArgs = this.options.allowLocalRepositoriesForTests === true && isAbsolute(repositoryUrl)
        ? []
        : SAFE_EXTERNAL_GIT_ARGS;
      const result = exists
        ? await runProcess(
            "git",
            [...externalGitArgs, "--git-dir", mirrorPath, "fetch", "--prune", "origin"],
            this.config.stateDir,
            logPath,
            this.config.jobTimeoutSeconds * 1_000,
          )
        : await runProcess(
            "git",
            [...externalGitArgs, "clone", "--mirror", "--", repositoryUrl, mirrorPath],
            this.config.stateDir,
            logPath,
            this.config.jobTimeoutSeconds * 1_000,
          );
      if (result.exitCode !== 0) {
        throw new Error(`Git mirror ${exists ? "fetch" : "clone"} failed for ${repositoryUrl}. See git-fetch.log.`);
      }
      return { mirrorPath, repoKey };
    });
  }

  private async prepareSlot(
    job: InternalJob,
    mirrorPath: string,
    repoKey: string,
    slot: number,
    jobRoot: string,
  ): Promise<string> {
    const checkoutPath = join(this.config.stateDir, "slots", repoKey, `slot-${slot}`);
    await mkdir(join(this.config.stateDir, "slots", repoKey), { recursive: true });

    if (!(await pathExists(join(checkoutPath, ".git")))) {
      const clone = await this.runCommand(
        job,
        "git-slot.log",
        "git",
        ["clone", mirrorPath, checkoutPath],
        jobRoot,
      );
      if (!(await this.requireCommandSuccess(
        job,
        clone,
        "INFRASTRUCTURE_FAILURE",
        "GIT_CHECKOUT_FAILURE",
        `Unable to initialize Unity validation slot ${slot}.`,
      ))) return checkoutPath;
    }

    const fetch = await this.runCommand(
      job,
      "git-slot.log",
      "git",
      ["-C", checkoutPath, "fetch", "--prune", mirrorPath, "+refs/*:refs/remotes/unity-source/*"],
      jobRoot,
    );
    if (!(await this.requireCommandSuccess(
      job,
      fetch,
      "INFRASTRUCTURE_FAILURE",
      "GIT_FETCH_FAILURE",
      `Unable to refresh Unity validation slot ${slot}.`,
    ))) return checkoutPath;

    const reset = await this.runCommand(
      job,
      "git-slot.log",
      "git",
      ["-C", checkoutPath, "reset", "--hard"],
      jobRoot,
    );
    if (!(await this.requireCommandSuccess(
      job,
      reset,
      "INFRASTRUCTURE_FAILURE",
      "GIT_CHECKOUT_FAILURE",
      `Unable to reset Unity validation slot ${slot}.`,
    ))) return checkoutPath;

    const clean = await this.runCommand(
      job,
      "git-slot.log",
      "git",
      ["-C", checkoutPath, "clean", "-ffdx", "-e", "Library/"],
      jobRoot,
    );
    if (!(await this.requireCommandSuccess(
      job,
      clean,
      "INFRASTRUCTURE_FAILURE",
      "GIT_CHECKOUT_FAILURE",
      `Unable to clean Unity validation slot ${slot}.`,
    ))) return checkoutPath;

    const checkout = await this.runCommand(
      job,
      "git-slot.log",
      "git",
      ["-C", checkoutPath, "checkout", "--detach", job.request.commit],
      jobRoot,
    );
    if (!(await this.requireCommandSuccess(
      job,
      checkout,
      "INFRASTRUCTURE_FAILURE",
      "GIT_COMMIT_NOT_FOUND",
      `Commit ${job.request.commit} is not available in the validation mirror.`,
    ))) return checkoutPath;

    return checkoutPath;
  }

  private async withRepositoryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.repositoryLockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.repositoryLockTails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.repositoryLockTails.get(key) === tail) {
        this.repositoryLockTails.delete(key);
      }
    }
  }

  private async resolveUnityEditor(
    job: InternalJob,
    identity: UnityEditorIdentity,
  ): Promise<string | undefined> {
    const existing = await findUnityEditor(identity.version, this.config.editorRoots);
    if (existing) return existing;

    if (!this.config.autoInstallEditors) {
      await this.fail(
        job,
        "INFRASTRUCTURE_FAILURE",
        "UNITY_EDITOR_MISSING",
        `Unity ${identity.version} was not found under: ${this.config.editorRoots.join(", ")}. Automatic editor installation is disabled.`,
      );
      return undefined;
    }

    const installRoot = this.config.editorRoots[0];
    if (!installRoot) {
      await this.fail(
        job,
        "INFRASTRUCTURE_FAILURE",
        "UNITY_EDITOR_INSTALL_ROOT_MISSING",
        "Automatic Unity Editor installation requires at least one configured editor root.",
      );
      return undefined;
    }

    let installPromise = this.editorInstallPromises.get(identity.version);
    if (!installPromise) {
      installPromise = this.withEditorInstallerLock(() => this.installUnityEditor(identity, installRoot));
      this.editorInstallPromises.set(identity.version, installPromise);
      const trackedPromise = installPromise;
      const cleanupTrackedInstall = () => {
        if (this.editorInstallPromises.get(identity.version) === trackedPromise) {
          this.editorInstallPromises.delete(identity.version);
        }
      };
      void trackedPromise.then(cleanupTrackedInstall, cleanupTrackedInstall);
    }

    const result = await waitForPromiseOrAbort(installPromise, job.abortController.signal);
    if (!result) return undefined;

    const jobLogName = "unity-install.log";
    await copyFile(result.sharedLogPath, join(job.summary.artifactsDir, jobLogName)).catch(() => undefined);
    const step: UnityValidationStep = {
      name: "editor-install",
      status: result.status,
      durationSeconds: result.durationSeconds,
      exitCode: result.exitCode,
      log: jobLogName,
      failureCategory: result.status === "failed" ? "INFRASTRUCTURE_FAILURE" : undefined,
      failureCode: result.failureCode,
      message: result.message,
    };
    job.summary.steps.push(step);
    await this.persistSummary(job);

    if (result.status === "cancelled") {
      await this.fail(
        job,
        "INFRASTRUCTURE_FAILURE",
        result.failureCode ?? "UNITY_EDITOR_INSTALL_CANCELLED",
        result.message ?? `Unity ${identity.version} installation was cancelled.`,
      );
      return undefined;
    }
    if (result.status === "failed" || !result.editorPath) {
      await this.fail(
        job,
        "INFRASTRUCTURE_FAILURE",
        result.failureCode ?? "UNITY_EDITOR_INSTALL_FAILED",
        result.message ?? `Unity ${identity.version} could not be installed automatically.`,
      );
      return undefined;
    }

    return result.editorPath;
  }

  private async installUnityEditor(
    identity: UnityEditorIdentity,
    installRoot: string,
  ): Promise<UnityEditorInstallResult> {
    const startedAt = Date.now();
    const logsDir = join(this.config.stateDir, "editor-installs");
    const safeVersion = identity.version.replace(/[^A-Za-z0-9._-]+/g, "_");
    const sharedLogPath = join(logsDir, `${safeVersion}-${randomUUID()}.log`);
    const timeoutMs = this.config.editorInstallTimeoutSeconds * 1_000;

    try {
      await mkdir(logsDir, { recursive: true });
      await mkdir(installRoot, { recursive: true });
      const useUnityCli = this.config.editorInstaller === "unity-cli";
      const installerLabel = useUnityCli ? "Unity CLI" : "Unity Hub";
      const installerExecutable = useUnityCli
        ? this.config.unityCliExecutable
        : this.config.unityHubExecutable;
      const installPathArgs = useUnityCli
        ? ["--non-interactive", "install-path", "--set", installRoot]
        : ["--headless", "install-path", "--set", installRoot];
      const installPathResult = await runProcess(
        installerExecutable,
        installPathArgs,
        this.config.stateDir,
        sharedLogPath,
        timeoutMs,
        this.editorInstallerAbortController.signal,
      );
      if (installPathResult.cancelled) {
        return {
          status: "cancelled",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installPathResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_CANCELLED",
          message: `Unity ${identity.version} installation was cancelled because the validation worker is shutting down.`,
          sharedLogPath,
        };
      }
      if (installPathResult.timedOut) {
        return {
          status: "failed",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installPathResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_TIMEOUT",
          message: `Configuring the Unity Editor install path exceeded ${this.config.editorInstallTimeoutSeconds} seconds.`,
          sharedLogPath,
        };
      }
      if (installPathResult.exitCode !== 0) {
        return {
          status: "failed",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installPathResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_PATH_FAILED",
          message: `${installerLabel} could not set the Editor install path to ${installRoot}.`,
          sharedLogPath,
        };
      }

      const installArgs = useUnityCli
        ? [
            "--non-interactive",
            "install",
            identity.version,
            ...(identity.changeset ? ["--changeset", identity.changeset] : []),
            "--yes",
          ]
        : [
            "--headless",
            "install",
            "--version",
            identity.version,
            ...(identity.changeset ? ["--changeset", identity.changeset] : []),
          ];
      const installResult = await runProcess(
        installerExecutable,
        installArgs,
        this.config.stateDir,
        sharedLogPath,
        timeoutMs,
        this.editorInstallerAbortController.signal,
      );
      if (installResult.cancelled) {
        return {
          status: "cancelled",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_CANCELLED",
          message: `Unity ${identity.version} installation was cancelled because the validation worker is shutting down.`,
          sharedLogPath,
        };
      }
      if (installResult.timedOut) {
        return {
          status: "failed",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_TIMEOUT",
          message: `Installing Unity ${identity.version} exceeded ${this.config.editorInstallTimeoutSeconds} seconds.`,
          sharedLogPath,
        };
      }
      if (installResult.exitCode !== 0) {
        const revisionHint = identity.changeset
          ? ` with changeset ${identity.changeset}`
          : "; the project did not provide m_EditorVersionWithRevision, so archive-only releases may require a changeset";
        return {
          status: "failed",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_FAILED",
          message: `${installerLabel} failed to install Unity ${identity.version}${revisionHint}. See unity-install.log.`,
          sharedLogPath,
        };
      }

      const editorPath = await findUnityEditor(identity.version, this.config.editorRoots);
      if (!editorPath) {
        return {
          status: "failed",
          durationSeconds: roundSeconds(Date.now() - startedAt),
          exitCode: installResult.exitCode,
          failureCode: "UNITY_EDITOR_INSTALL_INCOMPLETE",
          message: `${installerLabel} reported success, but Unity ${identity.version} was not found under: ${this.config.editorRoots.join(", ")}.`,
          sharedLogPath,
        };
      }

      return {
        status: "passed",
        durationSeconds: roundSeconds(Date.now() - startedAt),
        exitCode: installResult.exitCode,
        editorPath,
        message: `Installed Unity ${identity.version}${identity.changeset ? ` (${identity.changeset})` : ""} into ${installRoot} with ${installerLabel}.`,
        sharedLogPath,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "UNITY_INSTALLER_MISSING"
        : "UNITY_EDITOR_INSTALL_FAILED";
      const installerExecutable = this.config.editorInstaller === "unity-cli"
        ? this.config.unityCliExecutable
        : this.config.unityHubExecutable;
      const installerVariable = this.config.editorInstaller === "unity-cli"
        ? "DEVSPACE_UNITY_CLI_EXECUTABLE"
        : "DEVSPACE_UNITY_HUB_EXECUTABLE";
      return {
        status: "failed",
        durationSeconds: roundSeconds(Date.now() - startedAt),
        failureCode: code,
        message: code === "UNITY_INSTALLER_MISSING"
          ? `Unity editor installer '${installerExecutable}' was not found; install the configured backend or set ${installerVariable}.`
          : `Automatic Unity ${identity.version} installation failed: ${error instanceof Error ? error.message : String(error)}`,
        sharedLogPath,
      };
    }
  }

  private async withEditorInstallerLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.editorInstallerTail;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    this.editorInstallerTail = previous.then(() => gate);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async ensurePersonalLicense(job: InternalJob, editorPath: string): Promise<boolean> {
    const licenseFile = this.config.personalLicenseFile;
    const emailFile = this.config.personalLicenseEmailFile;
    const passwordFile = this.config.personalLicensePasswordFile;
    if (!licenseFile && !emailFile && !passwordFile) return true;
    if (!licenseFile || !emailFile || !passwordFile) {
      await this.fail(
        job,
        "INFRASTRUCTURE_FAILURE",
        "UNITY_LICENSE_CREDENTIALS_INCOMPLETE",
        "Unity Personal activation requires license, email, and password file paths.",
      );
      return false;
    }
    if (this.personalLicenseActivated) return true;

    if (!this.personalLicenseActivation) {
      this.personalLicenseActivation = this.activatePersonalLicense(editorPath, licenseFile, emailFile, passwordFile)
        .then((result) => {
          this.personalLicenseActivated = result;
          return result;
        })
        .finally(() => {
          this.personalLicenseActivation = undefined;
        });
    }

    const startedAt = Date.now();
    const activated = await this.personalLicenseActivation;
    const step: UnityValidationStep = {
      name: "license-activation",
      status: activated ? "passed" : "failed",
      durationSeconds: roundSeconds(Date.now() - startedAt),
      failureCategory: activated ? undefined : "INFRASTRUCTURE_FAILURE",
      failureCode: activated ? undefined : "UNITY_LICENSE_ACTIVATION_FAILED",
      message: activated
        ? "Unity Personal license activation completed using file-backed credentials."
        : "Unity Personal license activation failed using the configured file-backed credentials.",
    };
    job.summary.steps.push(step);
    if (!activated) {
      await this.fail(job, "INFRASTRUCTURE_FAILURE", "UNITY_LICENSE_ACTIVATION_FAILED", step.message!);
      return false;
    }
    await this.persistSummary(job);
    return true;
  }

  private async activatePersonalLicense(
    editorPath: string,
    licenseFile: string,
    emailFile: string,
    passwordFile: string,
  ): Promise<boolean> {
    let serial: string;
    let email: string;
    let password: string;
    try {
      serial = extractUnityPersonalSerial(await readFile(licenseFile, "utf8"));
      email = (await readFile(emailFile, "utf8")).trim();
      password = (await readFile(passwordFile, "utf8")).replace(/[\r\n]+$/, "");
    } catch {
      return false;
    }
    if (!email || !password || email.includes("\0") || password.includes("\0")) return false;

    const blankProject = join(this.config.stateDir, "license-activation", "BlankProject");
    await mkdir(join(blankProject, "Assets"), { recursive: true });
    let delayMs = 15_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await runProcess(
        editorPath,
        [
          "-batchmode",
          "-nographics",
          "-quit",
          "-serial",
          serial,
          "-username",
          email,
          "-password",
          password,
          "-projectPath",
          blankProject,
          "-logFile",
          "-",
        ],
        blankProject,
        undefined,
        this.config.jobTimeoutSeconds * 1_000,
        this.editorInstallerAbortController.signal,
      );
      if (!result.cancelled && !result.timedOut && result.exitCode === 0) return true;
      if (attempt < 4) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      delayMs *= 2;
    }
    return false;
  }

  private async runUnityStep(
    job: InternalJob,
    editorPath: string,
    projectPath: string,
    name: string,
    extraArgs: string[],
    failureCategory: UnityValidationFailureCategory,
    nographics: boolean,
    resultFile?: string,
  ): Promise<boolean> {
    const logName = `${name}.log`;
    const args = ["-batchmode", ...(nographics ? ["-nographics"] : []), "-projectPath", projectPath, ...extraArgs, "-logFile", join(job.summary.artifactsDir, logName)];
    const startedAt = Date.now();
    const result = await this.runCommand(job, logName, editorPath, args, projectPath, true);
    const step: UnityValidationStep = {
      name,
      status: result.cancelled ? "cancelled" : result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      durationSeconds: roundSeconds(Date.now() - startedAt),
      exitCode: result.exitCode,
      log: logName,
      resultFile: resultFile ? basename(resultFile) : undefined,
    };
    job.summary.steps.push(step);

    if (result.cancelled) {
      step.failureCategory = "CANCELLED";
      step.failureCode = "CANCELLED";
      await this.fail(job, "CANCELLED", "CANCELLED", `Unity step '${name}' was cancelled.`, "cancelled");
      return false;
    }
    if (result.timedOut) {
      step.failureCategory = "TIMEOUT";
      step.failureCode = "UNITY_TIMEOUT";
      await this.fail(job, "TIMEOUT", "UNITY_TIMEOUT", `Unity step '${name}' exceeded ${this.config.jobTimeoutSeconds} seconds.`);
      return false;
    }
    const logContent = await readFile(join(job.summary.artifactsDir, logName), "utf8").catch(() => "");
    const infrastructure = classifyUnityInfrastructureFailure(logContent);
    if (infrastructure) {
      step.status = "failed";
      step.failureCategory = "INFRASTRUCTURE_FAILURE";
      step.failureCode = infrastructure;
      step.message = `Unity step '${name}' encountered an infrastructure failure.`;
      await this.fail(job, "INFRASTRUCTURE_FAILURE", infrastructure, step.message);
      return false;
    }
    if (result.exitCode !== 0) {
      const code = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_FAILED`;
      step.failureCategory = failureCategory;
      step.failureCode = code;
      step.message = `Unity step '${name}' exited with code ${result.exitCode}.`;
      await this.fail(job, failureCategory, code, step.message);
      return false;
    }
    if (name === "compile") {
      const compileFailure = classifyUnityCompileFailure(logContent);
      if (compileFailure) {
        step.status = "failed";
        step.failureCategory = "SOURCE_FAILURE";
        step.failureCode = compileFailure;
        step.message = "Unity reported script compilation errors even though the process exited successfully.";
        await this.fail(job, "SOURCE_FAILURE", compileFailure, step.message);
        return false;
      }
    }
    if (resultFile) {
      const testResult = await inspectUnityTestResult(resultFile);
      if (!testResult.present) {
        step.status = "failed";
        step.failureCategory = "TEST_FAILURE";
        step.failureCode = "TEST_RESULTS_MISSING";
        step.message = `Unity did not produce ${basename(resultFile)}.`;
        await this.fail(job, "TEST_FAILURE", "TEST_RESULTS_MISSING", step.message);
        return false;
      }
      if (testResult.failed === undefined) {
        step.status = "failed";
        step.failureCategory = "TEST_FAILURE";
        step.failureCode = "TEST_RESULTS_UNPARSEABLE";
        step.message = `Unity produced ${basename(resultFile)}, but its test failure count could not be determined.`;
        await this.fail(job, "TEST_FAILURE", "TEST_RESULTS_UNPARSEABLE", step.message);
        return false;
      }
      if (testResult.failed > 0) {
        step.status = "failed";
        step.failureCategory = "TEST_FAILURE";
        step.failureCode = "TESTS_FAILED";
        step.message = `${testResult.failed} Unity test${testResult.failed === 1 ? "" : "s"} failed.`;
        await this.fail(job, "TEST_FAILURE", "TESTS_FAILED", step.message);
        return false;
      }
    }
    await this.persistSummary(job);
    return true;
  }

  private async runCommand(job: InternalJob, logName: string, command: string, args: string[], cwd: string, unityOwnsLog = false): Promise<CommandResult> {
    if (job.abortController.signal.aborted) return { exitCode: null, timedOut: false, cancelled: true };
    const logPath = join(job.summary.artifactsDir, logName);
    try {
      return await runProcess(
        command,
        args,
        cwd,
        unityOwnsLog ? undefined : logPath,
        this.config.jobTimeoutSeconds * 1_000,
        job.abortController.signal,
        (child) => {
          job.child = child;
        },
      );
    } finally {
      job.child = undefined;
    }
  }

  private async requireCommandSuccess(
    job: InternalJob,
    result: CommandResult,
    category: UnityValidationFailureCategory,
    code: string,
    message: string,
  ): Promise<boolean> {
    if (result.cancelled) {
      await this.fail(job, "CANCELLED", "CANCELLED", "Validation cancelled.", "cancelled");
      return false;
    }
    if (result.timedOut) {
      await this.fail(job, "TIMEOUT", "COMMAND_TIMEOUT", message);
      return false;
    }
    if (result.exitCode !== 0) {
      await this.fail(job, category, code, message);
      return false;
    }
    return true;
  }

  private async fail(job: InternalJob, category: UnityValidationFailureCategory, code: string, message: string, status: UnityValidationStatus = "failed"): Promise<void> {
    job.summary.status = status;
    job.summary.failureCategory = category;
    job.summary.failureCode = code;
    job.summary.message = message;
    job.summary.completedAt = new Date().toISOString();
    await this.persistSummary(job);
  }

  private async persistSummary(job: InternalJob): Promise<void> {
    await mkdir(job.summary.artifactsDir, { recursive: true });
    await writeFile(join(job.summary.artifactsDir, "summary.json"), `${JSON.stringify(job.summary, null, 2)}\n`, "utf8");
  }
}

export async function readUnityEditorIdentity(projectPath: string): Promise<UnityEditorIdentity> {
  const versionPath = join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  const text = await readFile(versionPath, "utf8");
  const version = text.match(/^m_EditorVersion:\s*(\S+)\s*$/m)?.[1];
  if (!version) throw new Error(`Unable to read m_EditorVersion from ${versionPath}`);

  const revision = text.match(/^m_EditorVersionWithRevision:\s*(\S+)\s+\(([0-9a-fA-F]+)\)\s*$/m);
  return {
    version,
    changeset: revision?.[1] === version ? revision[2] : undefined,
  };
}

export async function readUnityVersion(projectPath: string): Promise<string> {
  return (await readUnityEditorIdentity(projectPath)).version;
}

export async function findUnityEditor(version: string, roots: string[]): Promise<string | undefined> {
  for (const root of roots) {
    for (const candidate of [
      join(root, version, "Editor", "Unity"),
      join(root, version, "Editor", "Unity.exe"),
      join(root, "Editor", "Unity"),
      join(root, "Editor", "Unity.exe"),
    ]) {
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export function extractUnityPersonalSerial(license: string): string {
  const encoded = license.match(/<DeveloperData\s+Value=["']([^"']+)["']\s*\/>/i)?.[1];
  if (!encoded) throw new Error("Unity license file does not contain DeveloperData.");
  const decoded = Buffer.from(encoded, "base64").toString("latin1");
  const serial = decoded.slice(4);
  if (serial.length !== 27 || /[\r\n\0]/.test(serial)) {
    throw new Error("Unity Personal serial extracted from DeveloperData is invalid.");
  }
  return serial;
}

export function classifyUnityInfrastructureFailure(log: string): string | undefined {
  if (/No valid Unity Editor license|LicensingClient|license.*(failed|invalid|unavailable)/i.test(log)) return "UNITY_LICENSE_FAILURE";
  if (/No space left on device|disk full/i.test(log)) return "DISK_FULL";
  return undefined;
}

export function classifyUnityCompileFailure(log: string): string | undefined {
  if (/\berror\s+CS\d{4}\b/i.test(log)) return "UNITY_COMPILATION_FAILED";
  if (/Scripts have compiler errors|Compilation failed|compile errors? detected/i.test(log)) return "UNITY_COMPILATION_FAILED";
  return undefined;
}

export function parseUnityTestFailureCount(xml: string): number | undefined {
  const rootFailed = xml.match(/<test-run\b[^>]*\bfailed=["'](\d+)["']/i)?.[1];
  if (rootFailed !== undefined) return Number(rootFailed);
  const failedCases = xml.match(/<test-case\b[^>]*\bresult=["']Failed["']/gi)?.length;
  return failedCases;
}

async function inspectUnityTestResult(path: string): Promise<{ present: boolean; failed?: number }> {
  if (!(await pathExists(path))) return { present: false };
  const xml = await readFile(path, "utf8");
  return { present: true, failed: parseUnityTestFailureCount(xml) };
}

async function loadProjectConfig(checkoutPath: string, configPath: string): Promise<UnityValidationProjectConfig> {
  const absolutePath = resolve(checkoutPath, configPath);
  assertPathInside(absolutePath, checkoutPath, "Unity validation config path");
  if (!(await pathExists(absolutePath))) return {};
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as UnityValidationProjectConfig;
  if (parsed.schema !== undefined && parsed.schema !== 1) {
    throw new Error(`Unsupported Unity validation config schema: ${parsed.schema}`);
  }
  return parsed;
}

function validateRepositoryUrl(
  repositoryUrl: string,
  allowedPrefixes: string[],
  allowLocalRepositoryForTests: boolean,
): void {
  if (!repositoryUrl.trim()) throw new Error("repositoryUrl is required.");
  if (repositoryUrl !== repositoryUrl.trim() || repositoryUrl.startsWith("-")) {
    throw new Error("repositoryUrl must be a canonical Git remote URL and may not be option-like.");
  }

  const localTestRepository = allowLocalRepositoryForTests && isAbsolute(repositoryUrl);
  if (!localTestRepository) {
    const windowsLocalPath = /^[A-Za-z]:[\\/]/.test(repositoryUrl);
    const scpStyleSsh = !windowsLocalPath
      && !repositoryUrl.includes("://")
      && !repositoryUrl.includes("::")
      && /^[A-Za-z0-9._-]+:(?!:)[^\s]+$/.test(repositoryUrl);
    let approvedRemote = scpStyleSsh;
    if (!approvedRemote) {
      try {
        const parsed = new URL(repositoryUrl);
        if (parsed.username || parsed.password) {
          throw new Error("repositoryUrl must not contain embedded credentials; configure Git credentials on Unity-Server instead.");
        }
        approvedRemote = parsed.protocol === "https:" || parsed.protocol === "ssh:";
      } catch (error) {
        if (error instanceof Error && error.message.includes("embedded credentials")) throw error;
        approvedRemote = false;
      }
    }
    if (!approvedRemote) {
      throw new Error("repositoryUrl must use credential-free HTTPS or SSH; local paths, file://, git://, and ext:: transports are not allowed.");
    }
  }

  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => repositoryUrl.startsWith(prefix))) {
    throw new Error(`Repository is not allowed by DEVSPACE_UNITY_ALLOWED_REPOSITORIES: ${repositoryUrl}`);
  }
}

function validateCommit(commit: string): void {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(commit)) {
    throw new Error("commit must be a full immutable hexadecimal Git commit SHA (40 or 64 characters), not a shortened SHA, branch, or tag.");
  }
}

function assertPathInside(path: string, root: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`) && !normalizedPath.startsWith(`${normalizedRoot}\\`)) {
    throw new Error(`${label} is outside the validation checkout: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  logPath: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  onSpawn?: (child: ChildProcess) => void,
): Promise<CommandResult> {
  if (signal?.aborted) return { exitCode: null, timedOut: false, cancelled: true };
  await mkdir(cwd, { recursive: true });
  const stream = logPath ? createWriteStream(logPath, { flags: "a" }) : undefined;
  return new Promise<CommandResult>((resolvePromise, reject) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child?.stdout?.unpipe(stream);
      child?.stderr?.unpipe(stream);
      if (child && !child.killed) child.kill("SIGTERM");
      if (stream && !stream.destroyed) stream.destroy();
      reject(error);
    };
    const resolveOnce = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const abort = () => {
      cancelled = true;
      child?.kill("SIGTERM");
    };

    stream?.once("error", rejectOnce);

    child = spawn(command, args, {
      cwd,
      stdio: stream ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    onSpawn?.(child);
    if (stream) {
      child.stdout?.pipe(stream, { end: false });
      child.stderr?.pipe(stream, { end: false });
    }

    timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => rejectOnce(error));
    child.once("close", (exitCode) => {
      cleanup();
      if (settled) return;
      const result = { exitCode, timedOut, cancelled };
      if (!stream) {
        resolveOnce(result);
        return;
      }
      child?.stdout?.unpipe(stream);
      child?.stderr?.unpipe(stream);
      stream.end(() => resolveOnce(result));
    });
  });
}

async function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  return new Promise<T | undefined>((resolvePromise, reject) => {
    const abort = () => resolvePromise(undefined);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function roundSeconds(milliseconds: number): number {
  return Math.round(milliseconds / 100) / 10;
}

function cloneSummary(summary: UnityValidationSummary): UnityValidationSummary {
  return JSON.parse(JSON.stringify(summary)) as UnityValidationSummary;
}
