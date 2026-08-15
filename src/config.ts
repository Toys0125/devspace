import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import { defaultUnityEditorRoots, type UnityRunnerConfig } from "./unity-validation.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  unity: UnityRunnerConfig;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseTrustProxy(value: string | undefined): boolean | number {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || ["0", "false", "no", "off"].includes(normalized)) return false;

  if (/^[1-9]\d*$/.test(normalized)) {
    const hops = Number(normalized);
    if (!Number.isSafeInteger(hops)) throw new Error(`Invalid DEVSPACE_TRUST_PROXY: ${value}`);
    return hops;
  }

  if (["true", "yes", "on"].includes(normalized)) return true;
  throw new Error(`Invalid DEVSPACE_TRUST_PROXY: ${value}`);
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "minimal";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseTrustProxy(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseUnityEditorInstaller(value: string | undefined): UnityRunnerConfig["editorInstaller"] {
  if (!value || value === "unity-cli") return "unity-cli";
  if (value === "hub") return "hub";
  throw new Error(`Invalid DEVSPACE_UNITY_EDITOR_INSTALLER: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];
  const stateDir = resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir()));
  const unityStateDir = resolve(
    expandHomePath(env.DEVSPACE_UNITY_STATE_DIR ?? files.config.unity?.stateDir ?? join(stateDir, "unity-runner")),
  );
  const unityEditorRoots = parsePathList(env.DEVSPACE_UNITY_EDITOR_ROOTS);
  const persistedUnityEditorRoots = files.config.unity?.editorRoots ?? [];
  const selectedUnityEditorRoots = unityEditorRoots.length > 0
    ? unityEditorRoots
    : persistedUnityEditorRoots.length > 0
      ? persistedUnityEditorRoots
      : defaultUnityEditorRoots();
  const unityAllowedRepositories = parsePathList(env.DEVSPACE_UNITY_ALLOWED_REPOSITORIES);
  const selectedUnityAllowedRepositories = unityAllowedRepositories.length > 0
    ? unityAllowedRepositories
    : files.config.unity?.allowedRepositoryPrefixes ?? [];
  const unityEnabled = env.DEVSPACE_UNITY_RUNNER === undefined
    ? files.config.unity?.enabled === true
    : parseBoolean(env.DEVSPACE_UNITY_RUNNER);
  const unityAllowAnyRepository = env.DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY === undefined
    ? files.config.unity?.allowAnyRepository === true
    : parseBoolean(env.DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY);
  if (unityEnabled && selectedUnityAllowedRepositories.length === 0 && !unityAllowAnyRepository) {
    throw new Error(
      "DEVSPACE_UNITY_RUNNER requires DEVSPACE_UNITY_ALLOWED_REPOSITORIES (or unity.allowedRepositoryPrefixes) to restrict executable Unity projects. Set DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY=1 only for an intentionally unrestricted development worker.",
    );
  }

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir,
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled:
      env.DEVSPACE_ARTIFACTS === undefined
        ? files.config.artifactsEnabled === true
        : parseBoolean(env.DEVSPACE_ARTIFACTS),
    artifactMaxFileBytes: parsePositiveInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    unity: {
      enabled: unityEnabled,
      stateDir: unityStateDir,
      editorRoots: selectedUnityEditorRoots.map((root) => resolve(expandHomePath(root))),
      maxConcurrentJobs: parsePositiveInteger(
        env.DEVSPACE_UNITY_MAX_CONCURRENT_JOBS ?? numberConfigValue(files.config.unity?.maxConcurrentJobs),
        1,
        "DEVSPACE_UNITY_MAX_CONCURRENT_JOBS",
        32,
      ),
      jobTimeoutSeconds: parsePositiveInteger(
        env.DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS ?? numberConfigValue(files.config.unity?.jobTimeoutSeconds),
        30 * 60,
        "DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS",
        24 * 60 * 60,
      ),
      autoInstallEditors: env.DEVSPACE_UNITY_AUTO_INSTALL_EDITORS === undefined
        ? files.config.unity?.autoInstallEditors === true
        : parseBoolean(env.DEVSPACE_UNITY_AUTO_INSTALL_EDITORS),
      editorInstallTimeoutSeconds: parsePositiveInteger(
        env.DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS
          ?? numberConfigValue(files.config.unity?.editorInstallTimeoutSeconds),
        2 * 60 * 60,
        "DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS",
        24 * 60 * 60,
      ),
      editorInstaller: parseUnityEditorInstaller(
        env.DEVSPACE_UNITY_EDITOR_INSTALLER ?? files.config.unity?.editorInstaller,
      ),
      unityCliExecutable: env.DEVSPACE_UNITY_CLI_EXECUTABLE?.trim()
        || files.config.unity?.unityCliExecutable?.trim()
        || "unity",
      unityHubExecutable: env.DEVSPACE_UNITY_HUB_EXECUTABLE?.trim()
        || files.config.unity?.unityHubExecutable?.trim()
        || "unityhub",
      xvfbExecutable: parseOptionalUnityExecutable(
        env.DEVSPACE_UNITY_XVFB_EXECUTABLE
          ?? files.config.unity?.xvfbExecutable
          ?? (process.platform === "linux" ? "xvfb-run" : undefined),
      ),
      sharedUpmCacheRoot: resolveOptionalUnityCachePath(
        env.DEVSPACE_UNITY_SHARED_UPM_CACHE_ROOT
          ?? files.config.unity?.sharedUpmCacheRoot
          ?? defaultUnitySharedUpmCacheRoot(env),
      ),
      personalLicenseFile: resolveOptionalPath(
        env.DEVSPACE_UNITY_PERSONAL_LICENSE_FILE ?? files.config.unity?.personalLicenseFile,
      ),
      personalLicenseEmailFile: resolveOptionalPath(
        env.DEVSPACE_UNITY_PERSONAL_EMAIL_FILE ?? files.config.unity?.personalLicenseEmailFile,
      ),
      personalLicensePasswordFile: resolveOptionalPath(
        env.DEVSPACE_UNITY_PERSONAL_PASSWORD_FILE ?? files.config.unity?.personalLicensePasswordFile,
      ),
      allowedRepositoryPrefixes: selectedUnityAllowedRepositories,
    },
    logging: parseLoggingConfig(env),
  };
}

function parseOptionalUnityExecutable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

function defaultUnitySharedUpmCacheRoot(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Unity", "cache", "upm");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "Unity", "upm");
  return join(homedir(), ".cache", "Unity", "upm");
}

function resolveOptionalUnityCachePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return resolve(expandHomePath(trimmed));
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(expandHomePath(trimmed)) : undefined;
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
