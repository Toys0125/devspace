import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import * as z from "zod/v4";
import { UnityValidationRunner, type UnityValidationSummary } from "./unity-validation.js";

function summaryText(summary: UnityValidationSummary): string {
  const lines = [
    `Unity validation ${summary.jobId}: ${summary.status}`,
    `Commit: ${summary.commit}`,
    summary.validatedCommit ? `Validated commit: ${summary.validatedCommit}` : undefined,
    `Profile: ${summary.profile}`,
    summary.unityVersion ? `Unity: ${summary.unityVersion}` : undefined,
    summary.failureCategory ? `Failure category: ${summary.failureCategory}` : undefined,
    summary.failureCode ? `Failure code: ${summary.failureCode}` : undefined,
    summary.message,
  ].filter(Boolean);

  if (summary.steps.length > 0) {
    lines.push("Steps:");
    for (const step of summary.steps) {
      lines.push(
        `- ${step.name}: ${step.status} (${step.durationSeconds}s${step.exitCode === undefined ? "" : `, exit ${step.exitCode}`})${step.failureCode ? ` [${step.failureCode}]` : ""}`,
      );
    }
  }
  lines.push(`Artifacts: ${summary.artifactsDir}`);
  return lines.join("\n");
}

export function registerUnityValidationTools(server: McpRegistrationTarget, runner: UnityValidationRunner): void {
  server.registerTool(
    "submit_unity_validation",
    {
      title: "Submit Unity validation",
      description:
        "Queue compile/test/build validation of an immutable Git commit on this Unity worker. Pass a repository URL and hexadecimal commit SHA, never a branch or tag. The worker clones/fetches its own isolated checkout, selects the exact Unity version from ProjectSettings/ProjectVersion.txt, optionally auto-installs a missing Editor when configured, and executes the requested profile from .unity-validation.json or the built-in compile/test/playmode/full profiles.",
      inputSchema: {
        repository_url: z.string().min(1).describe("Git clone URL available to the Unity worker."),
        commit: z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).describe("Full immutable hexadecimal Git commit SHA (40 or 64 characters)."),
        profile: z.string().min(1).optional().describe("Validation profile. Defaults to test."),
        project_path: z.string().optional().describe("Unity project path relative to repository root. Overrides .unity-validation.json."),
        config_path: z.string().optional().describe("Validation config path relative to repository root. Defaults to .unity-validation.json."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const summary = await runner.submit({ repositoryUrl: args.repository_url, commit: args.commit, profile: args.profile, projectPath: args.project_path, configPath: args.config_path });
      return {
        content: [{ type: "text", text: `${summaryText(summary)}\nUse get_unity_validation with this jobId until it reaches a terminal state.` }],
      };
    },
  );

  server.registerTool(
    "get_unity_validation",
    {
      title: "Get Unity validation",
      description:
        "Return the current status or final validation receipt for a Unity validation job, including the exact validated commit, Unity version, step results, and classified failure information.",
      inputSchema: {
        job_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id }) => ({
      content: [{ type: "text", text: summaryText(runner.get(job_id)) }],
    }),
  );

  server.registerTool(
    "read_unity_validation_log",
    {
      title: "Read Unity validation log",
      description:
        "Read the tail of one artifact from a Unity validation job. Common artifacts are unity-install.log, compile.log, editmode.log, editmode-results.xml, playmode.log, playmode-results.xml, build.log, validator-N.log, git-fetch.log, and summary.json.",
      inputSchema: {
        job_id: z.string().min(1),
        artifact: z.string().min(1).describe("Single artifact filename, not a path."),
        tail_lines: z.number().int().min(1).max(2_000).optional().describe("Defaults to 200 lines."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, artifact, tail_lines }) => ({
      content: [{ type: "text", text: await runner.readArtifact(job_id, artifact, tail_lines ?? 200) }],
    }),
  );

  server.registerTool(
    "cancel_unity_validation",
    {
      title: "Cancel Unity validation",
      description: "Cancel a queued or running Unity validation job.",
      inputSchema: {
        job_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => ({
      content: [{ type: "text", text: summaryText(await runner.cancel(job_id)) }],
    }),
  );

  server.registerTool(
    "unity_server_health",
    {
      title: "Unity server health",
      description:
        "Report Unity validation worker capacity, queue depth, configured Unity editor roots, automatic Editor-install status, and versions currently being installed. Use this to distinguish runner availability from source-code failures.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(runner.health(), null, 2) }],
    }),
  );
}
