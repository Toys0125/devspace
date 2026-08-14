---
name: unity-remote-validation
description: Validate Unity project changes on a separate Unity-Server MCP worker using immutable Git commits.
---

# Unity Remote Validation

Use this skill when the current DevSpace workspace contains a Unity project or
Unity package and a separate MCP connection named `Unity-Server` (or another
DevSpace instance exposing the Unity validation tools) is available.

The source DevSpace workspace is the source of truth. Do not edit the project on
the Unity worker and do not validate a mutable shared checkout.

## Required workflow

1. Make source changes in the current DevSpace workspace.
2. Run cheap non-Unity checks locally when useful.
3. Ensure the exact state to validate exists as an immutable Git commit.
4. Ensure that commit is reachable by the Unity worker through the repository
   URL supplied to it. A temporary validation ref is acceptable when needed.
5. Call `submit_unity_validation` on the Unity-Server connection with:
   - the repository clone URL;
   - the exact hexadecimal commit SHA;
   - the appropriate validation profile;
   - `projectPath` only when the repo config does not already specify it.
6. Poll `get_unity_validation` until the job is terminal.
7. On failure, use `read_unity_validation_log` for the failing step, repair the
   source in the original DevSpace workspace, create a new commit, and rerun.
8. Before reporting Unity validation as successful, compare the validated SHA
   from the receipt with the current source SHA. Any source edit after the
   validated commit makes the receipt stale.

Never submit a branch or tag as the validation identity. Validation results are
only valid for the exact SHA returned in `validatedCommit`.

## Profiles

Use the cheapest profile that answers the current question:

- `compile`: import and C# compilation only.
- `test`: compile plus EditMode tests.
- `playmode`: compile, EditMode tests, and PlayMode tests.
- `full`: the built-in full test profile, or the repository-defined `full`
  profile when `.unity-validation.json` overrides it.

Repository-defined profiles may also run custom validators and build methods.
Use a project-specific profile when the repository configuration provides one.

A practical cadence is:

- after a small implementation change: `compile`;
- after a logical unit is complete: targeted/project `test` profile;
- before claiming the Unity task is complete: the relevant `full` profile.

## Failure handling

Treat failure categories differently:

- `SOURCE_FAILURE`: inspect compile/import errors and repair source.
- `TEST_FAILURE`: inspect test XML/logs and repair behavior or tests.
- `BUILD_FAILURE`: inspect the build step and project build pipeline.
- `VALIDATION_FAILURE`: inspect the custom validator/profile configuration.
- `INFRASTRUCTURE_FAILURE`: do not change working source merely to address a
  missing editor/install failure, Unity license problem, Git fetch problem, or
  disk failure. A worker configured for automatic Editor installation will
  attempt to install the exact missing version before returning this category.
- `TIMEOUT`: inspect the log before deciding whether source or infrastructure is
  responsible.

`unity_server_health` can be used to check worker capacity, configured editor
roots, whether automatic Editor installation is enabled, and versions currently
being installed.

## Repository configuration

A repository may define `.unity-validation.json` at its root. Example:

```json
{
  "schema": 1,
  "projectPath": "Basis",
  "profiles": {
    "compile": {
      "compile": true
    },
    "test": {
      "compile": true,
      "editModeTests": true
    },
    "full": {
      "compile": true,
      "editModeTests": true,
      "playModeTests": true,
      "validators": [
        "Basis.Editor.Validation.ValidateProject"
      ],
      "build": {
        "target": "StandaloneWindows64",
        "executeMethod": "Basis.Editor.BuildAutomation.BuildValidationPlayer"
      }
    }
  }
}
```

Custom validator/build methods must arrange any project-specific output paths
through their normal Unity automation. The runner always records Unity logs and
its structured `summary.json` receipt.
