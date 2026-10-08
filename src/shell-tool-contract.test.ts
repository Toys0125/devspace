import assert from "node:assert/strict";
import { claudeInstructions } from "./tool-surfaces/claude.js";
import { codexInstructions } from "./tool-surfaces/codex.js";
import { GIT_COMMAND_POLICY } from "./tool-surfaces/types.js";

for (const description of [
  GIT_COMMAND_POLICY,
  claudeInstructions({ agents: "", skills: "" }),
  codexInstructions(),
]) {
  assert.match(description, /git add/);
  assert.match(description, /git commit/);
  assert.match(description, /git push/);
  assert.match(description, /git fetch/);
  assert.match(description, /git pull/);
}
