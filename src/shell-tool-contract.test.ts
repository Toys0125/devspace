import assert from "node:assert/strict";
import { shellCommandDescription, shellToolDescription } from "./server.js";

for (const mode of ["minimal", "full"] as const) {
  const description = shellToolDescription(mode);
  assert.doesNotMatch(description, /Use only for/i);
  assert.match(description, /git add/i);
  assert.match(description, /git commit/i);
  assert.match(description, /git push/i);
  assert.match(description, /git fetch/i);
  assert.match(description, /git pull/i);
  assert.match(description, /project source files/i);
}

const commandDescription = shellCommandDescription();
assert.match(commandDescription, /Git write/i);
assert.match(commandDescription, /git commit/i);
assert.match(commandDescription, /git push/i);
assert.doesNotMatch(commandDescription, /Must not create or modify project files/i);
