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
commit is checked out. When a new slot is needed and an initialized idle slot for
the same repository exists, DevSpace first attempts `cp -a --reflink=always` to
seed the new slot. On ZFS block-cloning-capable storage this makes the new checkout,
Git objects, and `Library/` share physical blocks until either slot changes them.
The seed slot is reserved from scheduling while it is copied. If reflinks are not
supported, DevSpace falls back to the normal Git clone path.

Separately, all Unity Editor launches share one runner-owned Package Manager cache.
This cross-project cache contains registry/package data and Git-LFS package content
only; project import artifacts remain inside each isolated `Library/`.

Artifacts for every job include `summary.json` plus Git/Unity logs and Unity
Test Framework XML when tests run.

## Worker configuration

Typical Unity-Server environment:

```bash
DEVSPACE_UNITY_RUNNER=1
DEVSPACE_UNITY_STATE_DIR=/root/.local/share/devspace/unity-runner
DEVSPACE_UNITY_EDITOR_ROOTS=/root/Unity/Hub/Editor
DEVSPACE_UNITY_MAX_CONCURRENT_JOBS=1
DEVSPACE_UNITY_JOB_TIMEOUT_SECONDS=7200
DEVSPACE_UNITY_AUTO_INSTALL_EDITORS=1
DEVSPACE_UNITY_EDITOR_INSTALL_TIMEOUT_SECONDS=7200
DEVSPACE_UNITY_EDITOR_INSTALLER=unity-cli
DEVSPACE_UNITY_CLI_EXECUTABLE=unity
DEVSPACE_UNITY_SHARED_UPM_CACHE_ROOT=/root/.cache/Unity/upm
DEVSPACE_UNITY_ALLOWED_REPOSITORIES=https://github.com/BasisVR/,https://github.com/Toys0125/
```

Because Unity executes project code during import, runner mode refuses to start
without a repository URL-prefix allowlist. For an intentionally unrestricted
development-only worker, `DEVSPACE_UNITY_ALLOW_ANY_REPOSITORY=1` is the explicit
escape hatch; do not use it on a worker exposed to untrusted submissions.

The exact editor is selected from the project's
`ProjectSettings/ProjectVersion.txt`. When `DEVSPACE_UNITY_AUTO_INSTALL_EDITORS=1`,
a missing version is installed into the first configured editor root before
validation continues. The default backend is Unity's standalone `unity` CLI,
which is suitable for headless/CI containers; the older Unity Hub CLI remains
available only as `DEVSPACE_UNITY_EDITOR_INSTALLER=hub` for compatibility.

The runner also reads `m_EditorVersionWithRevision` when present and supplies
that changeset to the installer. This is important for archive-only Editor
versions because the worker does not need a hardcoded version-to-changeset table.
For example, Basis currently records `6000.5.7f1 (017862109af0)` and the worker
can request that exact Editor build automatically.

Editor installations are deduplicated by version and globally serialized so
parallel validation jobs cannot race the installer or download the same Editor
version twice. A job waiting on an install can still be cancelled; the shared
install may continue so another queued validation can reuse it. Server shutdown
cancels active installer processes.

Automatic installs produce an `editor-install` validation step and
`unity-install.log`. Missing installer executables, install timeouts, download
or installer failures, and a reported-success-but-missing Editor remain
`INFRASTRUCTURE_FAILURE`; they are never treated as source failures. Automatic
installation is disabled by default because Editor downloads are large and
consume network/disk resources.

### Shared Package Manager cache

`DEVSPACE_UNITY_SHARED_UPM_CACHE_ROOT` defaults to Unity's normal per-user global
UPM cache location (`~/.cache/Unity/upm` on Linux). DevSpace supplies that path as
`UPM_CACHE_ROOT` to every Unity Editor process and enables the Package Manager's
Git-LFS cache at `<root>/git-lfs`. Because the location lives outside repository
slots, packages downloaded while validating one project can be reused by another
project or another validation slot. Keeping the OS-standard default also adopts
packages Unity has already cached before this feature is enabled. Set the variable
to `none` to opt out.

This cache is intentionally narrower than Unity `Library/`. DevSpace does not
share one mutable `Library/` between slots or unrelated projects. Reflink seeding
only shares immutable physical blocks initially; each slot still has its own files
and copy-on-write changes. Imported artifacts, script assemblies, shader artifacts,
and other project-local state therefore remain logically isolated.

For Unity caches that existed before reflink seeding was enabled, `scripts/reflink-unity-slots.sh`
can replace byte-identical files at matching `Library/`-relative paths with reflink
clones. By default it scans validator slots, `~/.devspace/worktrees`, and `~/Projects`,
so normal DevSpace/Git worktrees benefit as well as validation slots. Additional or
replacement roots can be supplied with repeated `--scan-root PATH` arguments. It
defaults to a dry run and refuses `--apply` while a Unity Editor process is detected:

```bash
./scripts/reflink-unity-slots.sh
./scripts/reflink-unity-slots.sh --apply
```

Run the migration only while validation jobs are stopped. The script preserves target
file metadata and flushes the backing filesystem before cloning so OpenZFS does not
reject dirty source blocks with `EAGAIN`. The scanner indexes files in one Python
process, filters by Library-relative path and size, and hashes only possible duplicate
groups in parallel. Discovery across scan roots also uses the same worker pool. Use
`--jobs N` to tune both discovery and hashing concurrency; the default is the smaller
of 8 workers or the detected CPU count.

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
# DevSpace's postinstall lifecycle script runs during npm ci.
COPY devspace/scripts/ ./scripts/
RUN npm ci
COPY devspace/ ./
RUN npm run build \
 && npm pack --pack-destination /out

FROM <your-unity-server-base-image>

# Linux Unity Editor validation needs a virtual X display. Unity's Input System
# can query GTK/X11 state even in batch mode; DevSpace therefore defaults to
# xvfb-run on Linux and runs the Editor with graphics enabled inside Xvfb.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

# Unity's standalone CLI is currently distributed from the beta channel.
# Install it outside /root so a persistent /root volume cannot pin an old CLI.
RUN curl -fsSL https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh \
 | UNITY_CLI_CHANNEL=beta UNITY_CLI_HOME=/usr/local bash \
 && unity --version

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

On Linux, `DEVSPACE_UNITY_XVFB_EXECUTABLE` defaults to `xvfb-run`. When enabled,
DevSpace wraps Editor activation/compile/test/build invocations in an automatically
allocated Xvfb display and intentionally omits `-nographics`; the virtual display
uses software rendering when no GPU is exposed. Set the variable to `none` only
when the project is known to be safe under true headless Editor execution. If
`xvfb-run` is missing, validation reports `UNITY_XVFB_MISSING` instead of relying
on an opaque Editor crash.

### Unity Personal activation with file-backed credentials

DevSpace can reproduce GameCI's Personal-license activation flow without placing
account credentials directly in environment variables. Configure all three file
paths together:

```text
DEVSPACE_UNITY_PERSONAL_LICENSE_FILE=/run/secrets/unity_license
DEVSPACE_UNITY_PERSONAL_EMAIL_FILE=/run/secrets/unity_email
DEVSPACE_UNITY_PERSONAL_PASSWORD_FILE=/run/secrets/unity_password
```

Keep the bootstrap `.ulf` separate from Unity's active Linux license path
(`/root/.local/share/unity3d/Unity/Unity_lic.ulf`). Unity replaces the active
file with a machine-bound server license after activation; the bootstrap copy
should remain immutable so it is available if activation is required again.

The worker reads `DeveloperData` from the `.ulf`, base64-decodes the embedded
27-character Personal serial using the same format used by GameCI, and invokes
the selected Unity Editor with `-serial`, `-username`, and `-password` against a
worker-owned blank project. Before exposing credentials to the Editor, the worker
first launches that blank project without credentials to verify whether an existing
server-bound license is already usable. Successful persistent licenses survive
worker restarts without repeating credential-based activation. Container recreation
also requires a stable Linux machine ID because Unity binds Personal ULF licenses to
`/etc/machine-id`. Only when the license check fails is activation serialized/shared
within the worker process
and retried up to five times with exponential backoff. Credential and serial
contents are not copied into validation receipts or job artifacts.

The Unity Editor activation interface requires these values as process
arguments, so they can briefly be visible to sufficiently privileged processes
inside the container. File-backed configuration prevents them from being stored
in the Compose environment or normal DevSpace logs, but cannot remove that Unity
Editor limitation.

A Docker Compose configuration can use secrets:

```yaml
services:
  unity-base-server:
    environment:
      DEVSPACE_UNITY_PERSONAL_LICENSE_FILE: /run/secrets/unity_license
      DEVSPACE_UNITY_PERSONAL_EMAIL_FILE: /run/secrets/unity_email
      DEVSPACE_UNITY_PERSONAL_PASSWORD_FILE: /run/secrets/unity_password
    volumes:
      - ./unity_home:/root
      - ./unity-machine-id:/etc/machine-id:ro
      - ./unity-machine-id:/var/lib/dbus/machine-id:ro
    secrets:
      - unity_license
      - unity_email
      - unity_password

secrets:
  unity_license:
    file: ./secrets/Unity_lic.ulf
  unity_email:
    file: ./secrets/unity_email
  unity_password:
    file: ./secrets/unity_password
```

Before recreating an already-activated container, capture its current machine ID
once on the Docker host:

```bash
docker exec unity_base_server cat /etc/machine-id > ./unity-machine-id
chmod 0444 ./unity-machine-id
```

The file is not an account secret, but it must remain stable. Unity's Linux
`Legacy.MachineBinding1` and `Legacy.MachineBinding2` use this value; allowing
Docker to generate a new `/etc/machine-id` on every recreation invalidates the
persisted `.ulf` and forces credential activation again. Keep both `/root` and
this machine-ID file persistent so the server-specific license state survives
container rebuilds.

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
