# Crowe Logic CLI draft editor

Crowe Logic CLI opens this Crowe Logic application when Control+G is pressed.
The existing draft appears in a dedicated text editor. Save and return, or save
and close the window, to put the edited draft back into the terminal. The CLI
does not submit it until Enter is pressed there.

The packaged entry point is `desktop-entry.js`. With no draft flag it loads the
existing `main.js`. With `--edit-draft /absolute/file.md` it starts the isolated
draft window, without loading workspace services, plugins, sign-in or telemetry.
The window uses a temporary Chromium profile for each invocation.

The launcher supplies `--edit-result /absolute/private/result.json`. On return,
the application creates this file with mode 0600 and a protocol version of 1.
Code 0 means return the saved file; code 2 means discard and preserve the CLI's
original draft. Code 1 reports a failure. Missing receipts are failures, even if
macOS `open -W` exits successfully. A receipt is created exclusively and cannot
overwrite an existing file. The renderer only accesses its original draft
through a restricted preload and an IPC check bound to that window's main frame.

The editor accepts UTF-8 files up to 1 MiB. It checks that the original inode and
contents still match before each save. Replaced files, symbolic links and hard
links are refused. Save errors leave the draft visible for copying or retrying.
Closing an unsaved draft asks whether to save, keep editing or discard it.

For a local macOS build:

```sh
npm ci
npm run test:draft-editor
CROWE_SKIP_NOTARIZE=1 npx electron-builder --config electron-builder.cli-editor.js --mac --arm64 --dir --config.npmRebuild=false
```

This local configuration uses `com.crowelogic.desktop.cli-editor` so macOS can
distinguish it from the existing production installation. It retains the Crowe
Logic name, branding and signing configuration. A local build is not a published
or notarized release. The CLI's `~/.config/crowe/editors.json` contains its exact
executable path. The CLI invokes `open -n -W -a <app> --args ...` on macOS and
checks the receipt before reading the edited draft.
