# Workspace-token persistence

The daemon owns `ConnectionSecretStorage` (`store`, `load`, `clear` by private
connection reference). `EncryptedConnectionSecretStorage` writes only binary
ciphertext to `<dataRoot>/databricks/credentials/<reference-hash>.bin`, using an
atomic temporary-file rename. Neither the catalogue generations nor runtime model
files contain the workspace token. CLI-profile credentials still come from the CLI.

## Real process boundary

The daemon is a separate Node process. It requests encryption/decryption over a
bounded, one-request-per-connection **Windows named pipe**, implemented by
`packages/platform/src/secret-encryption.ts`. The pipe name hashes the absolute,
case-normalized daemon data root, independent of HTTP ports. No capability file,
HTTP route, Electron renderer/preload channel, or plaintext temporary file is used.
The local Windows pipe's OS permissions are the transport trust boundary; code
running as the same Windows user is trusted, as with DPAPI itself.

`apps/desktop/src/main/secret-storage.ts` starts the provider after Electron
`app.whenReady()` and passes main-process `safeStorage`. On Windows this is DPAPI,
bound to the signed-in Windows account. Packaged supplies the exact namespace data
root to `runDesktopMain`; tools-dev launches desktop/daemon from the same workspace
root and environment. Both shells therefore use the same provider. Shutdown closes
the pipe. Packaged headless and a plain development daemon have no provider.

Only Electron encrypts/decrypts; only the daemon owns credential files. `clear`
therefore erases credentials even when Electron is absent. Setup validates before
saving. Restart loads and validates the token before reporting authenticated state.
Rejected setup/restart identity validation, scan/verification HTTP 401 responses,
and runtime relay HTTP 401 responses erase the cached and saved token. Transient
network failures are not treated as token rejection.

## Honest degradation

If there is no encryption host, safeStorage reports unavailable, or an encrypted
write fails, setup retains the validated token only in memory. The existing status
`issues` array reports `DATABRICKS_KEYRING_UNAVAILABLE` with `action: sign-in`; the
daemon emits a fixed warning explaining that re-entry is required after restart.
No HTTP DTO shape changes, no credential-bearing error details, and no plaintext
fallback. Replacing a saved credential first removes the superseded ciphertext so
it cannot unexpectedly reappear after a memory-only replacement. Failure to erase
is an explicit error, never a successful disconnect.

Tests use authenticated AES-GCM as an injected OS-encryption stand-in and exercise
real Windows pipes (including a separate Node process), real HTTP setup, binary
files, service/host restarts, and invalidation. Electron/DPAPI execution itself is
not exercised by these Node tests. Portability is intentionally limited: copying
the data directory to another Windows account/machine does not transfer its DPAPI
key and may require token re-entry. Protection concerns application-written files;
OS-managed process dumps/page files are outside the persistence contract.
