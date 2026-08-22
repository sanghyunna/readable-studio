import { join } from "node:path";

import type { ToolPackConfig } from "../config.js";
import {
  WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME,
  WIN_PREBUNDLE_META_DIR_NAME,
  WIN_PREBUNDLED_APP_DIR_NAME,
  WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  WIN_PREBUNDLED_PACKAGED_MAIN_RELATIVE_PATH,
  WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
} from "../win-prebundle.js";
import { PRODUCT_NAME, RESOURCE_TREE_NAME } from "./constants.js";
import type { WinPaths } from "./types.js";

export function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function resolveWinPaths(config: ToolPackConfig): WinPaths {
  const namespaceToken = sanitizeNamespace(config.namespace);
  const namespaceRoot = config.roots.output.namespaceRoot;
  return {
    appBuilderConfigPath: join(namespaceRoot, "builder-config.json"),
    appBuilderOutputRoot: join(namespaceRoot, "builder"),
    assembledAppRoot: join(namespaceRoot, "assembled", "app"),
    assembledMainEntryPath: join(namespaceRoot, "assembled", "app", "main.cjs"),
    assembledPackageJsonPath: join(namespaceRoot, "assembled", "app", "package.json"),
    assembledPrebundledRoot: join(namespaceRoot, "assembled", "app", WIN_PREBUNDLED_APP_DIR_NAME),
    builtManifestPath: join(namespaceRoot, "built-app.json"),
    daemonCliPrebundleEntrypointPath: join(namespaceRoot, WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME, "daemon-cli.js"),
    daemonCliPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH),
    daemonPrebundleMetaPath: join(namespaceRoot, WIN_PREBUNDLE_META_DIR_NAME, "daemon.meta.json"),
    daemonPrebundleRoot: join(namespaceRoot, "assembled", "app", WIN_PREBUNDLED_APP_DIR_NAME, "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(namespaceRoot, WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME, "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH),
    packagedConfigPath: join(namespaceRoot, "readable-studio-config.json"),
    packagedMainPrebundleMetaPath: join(namespaceRoot, WIN_PREBUNDLE_META_DIR_NAME, "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_PACKAGED_MAIN_RELATIVE_PATH),
    resourceRoot: join(namespaceRoot, "resources", RESOURCE_TREE_NAME),
    setupZipPath: join(namespaceRoot, "builder", `${PRODUCT_NAME}-${namespaceToken}-portable.zip`),
    tarballsRoot: join(namespaceRoot, "tarballs"),
    webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
    webSidecarPrebundleMetaPath: join(namespaceRoot, WIN_PREBUNDLE_META_DIR_NAME, "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH),
    winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
    unpackedExePath: join(namespaceRoot, "builder", "win-unpacked", `${PRODUCT_NAME}.exe`),
    unpackedRoot: join(namespaceRoot, "builder", "win-unpacked"),
  };
}
