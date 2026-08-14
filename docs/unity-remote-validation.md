# Remote Unity validation

DevSpace can be used in a two-plane Unity workflow:

- the normal/source DevSpace connection owns source inspection, editing, Git,
  and non-Unity checks;
- a second DevSpace deployment on the Unity machine runs as a Unity validation
  worker and owns Unity import, compilation, tests, validators, and builds.

The validation identity is always an immutable Git commit SHA. The Unity worker
never edits or validates the source-side live checkout.

## Source-side tools

Every DevSpace instance exposes:

- `prepare_unity_validation`: returns the current HEAD SHA, selected remote URL,
  dirty state, detected Unity project roots, and whether `.unity-validation.json`
  is present;
- `check_unity_validation_receipt`: confirms that a returned Unity validation
  SHA still matches the current clean workspace state.

The bundled `unity-remote-validation` skill describes the full agent workflow.

## Unity worker tools

When `DEVSPACE_UNITY_RUNNER=1`, the worker additionally exposes:

- `submit_unity_validation`
- `get_unity_validation`
- `read_unity_validation_log`
- `cancel_unity_validation`
- `unity_server_health`

The worker maintains persistent bare Git mirrors and isolated validation slots.
Each repository/slot pair preserves only the ignored Unity `Library/` directory
between jobs; other generated/untracked state is cleaned before the next exact
commit is checked out.

Artifacts for every job include `summary.json` plus Git/Unity logs and Unity
Test Framework XML when tests run.

## Worker configuration

Typical Unity-Server environment:

```bash
DEVSPACE_UNITY_RUNNER=1
DEVSPACE_UNITY_STATE_DIR=/root/.local/share/devspace/unity-runner
DEVSPACE_UNITY_EDITOR_ROOTS=/root/Unity/Hub/Editor
DEVSPACE_UNITY_MAX_CONCURRENT_JOBS=1
DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS=1800
DEVSPACE_UNITY_ALLOWED_REPOSITORIES=https://github.com/BasisVR/,https://github.com/Toys0125/
```

Because Unity executes project code during import, runner mode refuses to start
without a repository URL-prefix allowlist. For an intentionally unrestricted
development-only worker, `DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY=1` is the explicit
escape hatch; do not use it on a worker exposed to untrusted submissions.

The exact editor is selected from the project's
`ProjectSettings/ProjectVersion.txt`. A missing editor is classified as an
infrastructure failure rather than a source failure.

## Project configuration

Projects may commit `.unity-validation.json`:

```json
{
  "schema": 1,
  "projectPath": ".",
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
        "Example.Editor.Validation.ValidateProject"
      ],
      "build": {
        "target": "StandaloneLinux64",
        "executeMethod": "Example.Editor.BuildAutomation.BuildValidationPlayer"
      }
    }
  }
}
```

Built-in profiles exist when a project does not override them:

- `compile`: import/compile;
- `test`: compile + EditMode;
- `playmode`: compile + EditMode + PlayMode;
- `full`: compile + EditMode + PlayMode.

Custom validator and build methods are ordinary Unity `-executeMethod` entry
points and should fail the batch process when validation/build fails.

## Installing a custom DevSpace build in Docker

A Unity-Server container must run the same custom DevSpace build that contains
the Unity tools. Installing the public `@waishnav/devspace` npm release will not
include unmerged fork changes.

For a reproducible image, build the package in a Docker build stage from a
pinned fork revision, create an npm tarball, and install that tarball globally
in the final Unity image:

```dockerfile
FROM node:24-bookworm AS devspace-build
WORKDIR /src/devspace

# Prefer a pinned source tree/commit supplied by the build context. If this
# Dockerfile lives in another repository, clone the fork at a pinned SHA here
# instead.
COPY devspace/package.json devspace/package-lock.json ./
RUN npm ci
COPY devspace/ ./
RUN npm run build \
 && npm pack --pack-destination /out

FROM <your-unity-server-base-image>
COPY --from=devspace-build /out/*.tgz /tmp/devspace.tgz
RUN npm install -g /tmp/devspace.tgz \
 && rm /tmp/devspace.tgz \
 && devspace version
```

If the Unity image already contains Node/npm, only the package build/install
steps are required. Install the executable into the image's normal global npm
prefix (normally `/usr/local/bin` and `/usr/local/lib/node_modules`) rather than
under `/root`. This keeps the executable immutable with the image while allowing
`/root/.devspace` and the Unity runner state/cache to live on the persistent
root-home volume.

Rebuild/recreate the Unity-Server container whenever the custom DevSpace package
changes. Merely restarting a container built with the upstream npm release will
not pick up fork changes.

## Git transport

The source agent must ensure that the exact commit SHA is reachable through the
repository URL submitted to the worker. The worker accepts only credential-free
HTTPS or SSH remotes; local paths, `file://`, `git://`, `ext::`, option-like
values, and URLs containing embedded user/password information are rejected.
External Git commands disable protocols by default and explicitly enable only
HTTPS and SSH. For private repositories, configure narrowly scoped read-only
credentials on the worker itself rather than passing them through MCP arguments.
`prepare_unity_validation` redacts userinfo it discovers in a source remote.

Temporary validation refs are acceptable. The worker's mirror follows the
remote mirror refspec so commits reachable from custom refs can be validated,
not only normal branches and tags.

## Result categories

Validation receipts distinguish:

- `SOURCE_FAILURE`
- `TEST_FAILURE`
- `BUILD_FAILURE`
- `VALIDATION_FAILURE`
- `INFRASTRUCTURE_FAILURE`
- `TIMEOUT`
- `CANCELLED`

Unity licensing errors, missing editors, disk-full errors, and Git transport
failures must not be treated as evidence that the source code needs changing.
