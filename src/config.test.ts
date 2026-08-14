import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig(baseEnv).unity.enabled, false);
assert.equal(loadConfig(baseEnv).unity.maxConcurrentJobs, 1);
assert.equal(loadConfig(baseEnv).unity.jobTimeoutSeconds, 30 * 60);
assert.equal(loadConfig(baseEnv).unity.autoInstallEditors, false);
assert.equal(loadConfig(baseEnv).unity.editorInstallTimeoutSeconds, 2 * 60 * 60);
assert.equal(loadConfig(baseEnv).unity.editorInstaller, "unity-cli");
assert.equal(loadConfig(baseEnv).unity.unityCliExecutable, "unity");
assert.equal(loadConfig(baseEnv).unity.unityHubExecutable, "unityhub");
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_UNITY_RUNNER: "1" }),
  /DEVSPACE_UNITY_RUNNER requires DEVSPACE_UNITY_ALLOWED_REPOSITORIES/,
);
assert.equal(
  loadConfig({
    ...baseEnv,
    DEVSPACE_UNITY_RUNNER: "1",
    DEVSPACE_UNITY_ALLOWED_REPOSITORIES: "https://github.com/BasisVR/",
  }).unity.enabled,
  true,
);
assert.equal(
  loadConfig({
    ...baseEnv,
    DEVSPACE_UNITY_RUNNER: "1",
    DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY: "1",
  }).unity.enabled,
  true,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_MAX_CONCURRENT_JOBS: "3" }).unity.maxConcurrentJobs,
  3,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS: "45" }).unity.jobTimeoutSeconds,
  45,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_AUTO_INSTALL_EDITORS: "1" }).unity.autoInstallEditors,
  true,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS: "123" }).unity.editorInstallTimeoutSeconds,
  123,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_EDITOR_INSTALLER: "hub" }).unity.editorInstaller,
  "hub",
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_CLI_EXECUTABLE: "/opt/unity" }).unity.unityCliExecutable,
  "/opt/unity",
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_HUB_EXECUTABLE: "/opt/unityhub" }).unity.unityHubExecutable,
  "/opt/unityhub",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_EDITOR_ROOTS: "/unity/a,/unity/b" }).unity.editorRoots,
  ["/unity/a", "/unity/b"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_UNITY_ALLOWED_REPOSITORIES: "https://github.com/BasisVR/,git@github.com:Toys0125/" }).unity.allowedRepositoryPrefixes,
  ["https://github.com/BasisVR/", "git@github.com:Toys0125/"],
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { DEVSPACE_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { DEVSPACE_SUBAGENTS: "1" }), true);

const seededConfigDir = mkdtempSync(join(tmpdir(), "devspace-seeded-skills-test-"));
const seededSkillPaths = ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [
  join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md"),
  join(seededConfigDir, "skills", "unity-remote-validation", "SKILL.md"),
]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.equal(existsSync(seededSkillPaths[1]), true);
assert.match(readFileSync(seededSkillPaths[1], "utf8"), /name: unity-remote-validation/);
assert.deepEqual(ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir }), []);

const unityOnlySkillsDir = mkdtempSync(join(tmpdir(), "devspace-unity-only-skills-test-"));
assert.deepEqual(
  ensureDevspaceDefaultSkills(
    { DEVSPACE_CONFIG_DIR: unityOnlySkillsDir },
    { subagents: false },
  ),
  [join(unityOnlySkillsDir, "skills", "unity-remote-validation", "SKILL.md")],
);
assert.equal(
  existsSync(join(unityOnlySkillsDir, "skills", "subagent-delegation", "SKILL.md")),
  false,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, 1);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "2" }).logging.trustProxy, 2);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "true" }).logging.trustProxy, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "0" }).logging.trustProxy, false);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "cloudflare" }),
  /Invalid DEVSPACE_TRUST_PROXY: cloudflare/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_UNITY_MAX_CONCURRENT_JOBS: "0" }),
  /Invalid DEVSPACE_UNITY_MAX_CONCURRENT_JOBS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS: "0" }),
  /Invalid DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS: "0" }),
  /Invalid DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_UNITY_EDITOR_INSTALLER: "magic" }),
  /Invalid DEVSPACE_UNITY_EDITOR_INSTALLER: magic/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
    unity: {
      editorRoots: [],
    },
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents, true);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.ok(fileConfig.unity.editorRoots.length > 0);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);
