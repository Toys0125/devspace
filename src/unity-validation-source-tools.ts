import { access, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { git, getGitEligibility } from "./git.js";
import { WorkspaceRegistry } from "./workspaces.js";

export function registerUnityValidationSourceTools(
  server: McpServer,
  workspaces: WorkspaceRegistry,
): void {
  server.registerTool(
    "prepare_unity_validation",
    {
      title: "Prepare Unity validation",
      description:
        "Inspect an open DevSpace Git workspace and return the immutable HEAD SHA, clone URL, dirty state, and detected Unity project paths needed to submit that exact source state to a separate Unity-Server validation worker. This tool does not push or modify Git state.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace identifier returned by open_workspace."),
        remote: z.string().min(1).optional().describe("Git remote to use. Defaults to origin."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, remote }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const eligibility = await getGitEligibility(workspace.root);
      if (!eligibility.ok || !eligibility.gitRoot) {
        throw new Error(eligibility.message ?? "Workspace is not an eligible Git repository.");
      }

      const gitRoot = eligibility.gitRoot;
      const commit = (await git(gitRoot, ["rev-parse", "HEAD^{commit}"])).stdout.trim();
      const status = (await git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout;
      const dirty = status.trim().length > 0;
      const remoteName = remote ?? "origin";
      let rawRepositoryUrl: string;
      try {
        rawRepositoryUrl = (await git(gitRoot, ["remote", "get-url", remoteName])).stdout.trim();
      } catch {
        throw new Error(`Git remote '${remoteName}' is not configured for ${gitRoot}.`);
      }
      const { repositoryUrl, credentialsRedacted } = redactRemoteUrl(rawRepositoryUrl);
      const unityProjects = await discoverUnityProjects(gitRoot);
      const configPresent = await exists(`${gitRoot}/.unity-validation.json`);
      const relativeWorkspaceRoot = relative(gitRoot, workspace.root).split("\\").join("/") || ".";

      const result = {
        workspaceId,
        gitRoot,
        workspaceRoot: relativeWorkspaceRoot,
        remote: remoteName,
        repositoryUrl,
        credentialsRedacted,
        commit,
        dirty,
        unityProjects,
        configPresent,
        ready: !dirty,
      };

      return {
        content: [
          {
            type: "text",
            text: [
              JSON.stringify(result, null, 2),
              dirty
                ? "This workspace has uncommitted changes. Commit the exact state before submitting Unity validation; do not validate this HEAD as if it included the dirty files."
                : "This workspace is clean. The returned commit is an immutable validation identity; ensure it is reachable from the returned repository URL before submitting it to Unity-Server.",
              credentialsRedacted
                ? "Credentials embedded in the Git remote were redacted. Configure read-only Git credentials on Unity-Server instead of sending credentials through MCP tool arguments."
                : undefined,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "check_unity_validation_receipt",
    {
      title: "Check Unity validation receipt",
      description:
        "Compare a Unity validation receipt's exact commit SHA with the current DevSpace workspace state. The receipt is current only when HEAD matches and the workspace has no uncommitted changes.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace identifier returned by open_workspace."),
        validatedCommit: z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).describe("Full exact SHA from the Unity validation receipt."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, validatedCommit }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const eligibility = await getGitEligibility(workspace.root);
      if (!eligibility.ok || !eligibility.gitRoot) {
        throw new Error(eligibility.message ?? "Workspace is not an eligible Git repository.");
      }
      const currentCommit = (await git(eligibility.gitRoot, ["rev-parse", "HEAD^{commit}"])).stdout.trim();
      const dirty = (await git(eligibility.gitRoot, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout.trim().length > 0;
      const commitMatches = currentCommit.toLowerCase() === validatedCommit.toLowerCase();
      const current = commitMatches && !dirty;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                current,
                commitMatches,
                dirty,
                currentCommit,
                validatedCommit,
                message: current
                  ? "The Unity validation receipt is current for this clean workspace state."
                  : dirty
                    ? "The receipt is stale because the workspace has uncommitted changes."
                    : "The receipt is stale because HEAD no longer matches the validated commit.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

export function redactRemoteUrl(repositoryUrl: string): {
  repositoryUrl: string;
  credentialsRedacted: boolean;
} {
  const scpStyle = repositoryUrl.match(/^([^/@:\s]+)@([^:\s]+):(.+)$/);
  if (scpStyle) {
    return {
      repositoryUrl: `${scpStyle[2]}:${scpStyle[3]}`,
      credentialsRedacted: true,
    };
  }

  try {
    const parsed = new URL(repositoryUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return { repositoryUrl: parsed.toString(), credentialsRedacted: true };
    }
  } catch {
    // Local paths and non-URL remotes without userinfo are returned unchanged.
  }
  return { repositoryUrl, credentialsRedacted: false };
}

async function discoverUnityProjects(gitRoot: string): Promise<string[]> {
  const found: string[] = [];
  if (await exists(`${gitRoot}/ProjectSettings/ProjectVersion.txt`)) found.push(".");

  const entries = await readdir(gitRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (await exists(`${gitRoot}/${entry.name}/ProjectSettings/ProjectVersion.txt`)) {
      found.push(entry.name);
    }
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
