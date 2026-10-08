import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { defaultUnityEditorRoots, type UnityRunnerConfig } from "./unity-validation.js";
import type { DevspaceConfig } from "./config-schema.js";

export type { ToolMode } from "./config-schema.js";

export interface ServerConfig {
  configDir: string;
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  uiEnabled: boolean;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
  unity: UnityRunnerConfig;
  logging: LoggingConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const stored = files.config;
  const host = stored.server.host;
  const port = stored.server.port;
  const publicBaseUrl = parsePublicBaseUrl(
    stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const stateDir = normalizePath(stored.storage.stateDir);
  const unity = resolveUnityConfig(env, stored.unity, stateDir);
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];

  return {
    configDir: files.dir,
    host,
    port,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: stored.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: stored.oauth.refreshTokenTtlSeconds,
      scopes: stored.oauth.scopes,
      allowedResourceUrls: stored.oauth.allowedResourceUrls,
      allowedRedirectHosts: stored.oauth.allowedRedirectHosts,
    },
    allowedRoots: normalizePaths(stored.workspaces.allowedRoots, [process.cwd()]),
    allowedHosts: normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    toolMode: stored.tools.mode,
    uiEnabled: stored.ui.enabled,
    stateDir,
    worktreeRoot: normalizePath(stored.workspaces.worktreeRoot),
    artifactsEnabled: stored.artifacts.enabled,
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: stored.skills.enabled,
    skillPaths: stored.skills.paths,
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: stored.subagents,
    agentDir: normalizePath(stored.skills.agentDir),
    unity,
    logging: {
      ...stored.logging,
      trustProxy: stored.server.trustProxy,
    },
  };
}

type StoredUnityConfig = DevspaceConfig["unity"];

function unityBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`Invalid Unity boolean configuration: ${value}`);
}

function unityNumber(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

function unityPaths(value: string | undefined, fallback: string[]): string[] {
  return value === undefined ? fallback : value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function unityOptionalPath(value: string | undefined): string | undefined {
  return value && value.trim() && value !== "none" ? normalizePath(value.trim()) : undefined;
}

function unityOptionalExecutable(value: string | undefined): string | undefined {
  return value && value.trim() && value !== "none" ? value.trim() : undefined;
}

function resolveUnityConfig(
  env: NodeJS.ProcessEnv,
  stored: StoredUnityConfig,
  stateDir: string,
): UnityRunnerConfig {
  const enabled = unityBoolean(env.DEVSPACE_UNITY_RUNNER, stored.enabled);
  const allowedRepositoryPrefixes = unityPaths(
    env.DEVSPACE_UNITY_ALLOWED_REPOSITORIES,
    stored.allowedRepositoryPrefixes,
  );
  const allowAnyRepository = unityBoolean(
    env.DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY,
    stored.allowAnyRepository,
  );
  if (enabled && allowedRepositoryPrefixes.length === 0 && !allowAnyRepository) {
    throw new Error(
      "Unity validation requires DEVSPACE_UNITY_ALLOWED_REPOSITORIES or unity.allowedRepositoryPrefixes; set DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY=1 only for an intentionally unrestricted worker.",
    );
  }
  const editorInstaller = env.DEVSPACE_UNITY_EDITOR_INSTALLER ?? stored.editorInstaller;
  if (editorInstaller !== "unity-cli" && editorInstaller !== "hub") {
    throw new Error(`Invalid DEVSPACE_UNITY_EDITOR_INSTALLER: ${editorInstaller}`);
  }
  return {
    enabled,
    stateDir: normalizePath(env.DEVSPACE_UNITY_STATE_DIR ?? stored.stateDir ?? join(stateDir, "unity-runner")),
    editorRoots: unityPaths(env.DEVSPACE_UNITY_EDITOR_ROOTS, stored.editorRoots.length
      ? stored.editorRoots : defaultUnityEditorRoots()).map(normalizePath),
    maxConcurrentJobs: unityNumber(env.DEVSPACE_UNITY_MAX_CONCURRENT_JOBS, stored.maxConcurrentJobs, "DEVSPACE_UNITY_MAX_CONCURRENT_JOBS", 32),
    jobTimeoutSeconds: unityNumber(env.DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS, stored.jobTimeoutSeconds, "DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS", 24 * 60 * 60),
    autoInstallEditors: unityBoolean(env.DEVSPACE_UNITY_AUTO_INSTALL_EDITORS, stored.autoInstallEditors),
    editorInstallTimeoutSeconds: unityNumber(env.DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS, stored.editorInstallTimeoutSeconds, "DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS", 24 * 60 * 60),
    editorInstaller,
    unityCliExecutable: env.DEVSPACE_UNITY_CLI_EXECUTABLE?.trim() || stored.unityCliExecutable,
    unityHubExecutable: env.DEVSPACE_UNITY_HUB_EXECUTABLE?.trim() || stored.unityHubExecutable,
    xvfbExecutable: unityOptionalExecutable(env.DEVSPACE_UNITY_XVFB_EXECUTABLE
      ?? stored.xvfbExecutable ?? (process.platform === "linux" ? "xvfb-run" : undefined)),
    sharedUpmCacheRoot: unityOptionalPath(env.DEVSPACE_UNITY_SHARED_UPM_CACHE_ROOT
      ?? stored.sharedUpmCacheRoot ?? join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "Unity", "upm")),
    personalLicenseFile: unityOptionalPath(env.DEVSPACE_UNITY_PERSONAL_LICENSE_FILE ?? stored.personalLicenseFile),
    personalLicenseEmailFile: unityOptionalPath(env.DEVSPACE_UNITY_PERSONAL_EMAIL_FILE ?? stored.personalLicenseEmailFile),
    personalLicensePasswordFile: unityOptionalPath(env.DEVSPACE_UNITY_PERSONAL_PASSWORD_FILE ?? stored.personalLicensePasswordFile),
    allowedRepositoryPrefixes,
  };
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: devspace init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
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
