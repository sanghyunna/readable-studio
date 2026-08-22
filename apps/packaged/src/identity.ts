import { dirname } from "node:path";

import { removeFile, writeJsonFile } from "@readable-studio/sidecar";
import type { RuntimeDescriptor, SidecarStamp } from "@readable-studio/sidecar-proto";

import type { PackagedNamespacePaths } from "./paths.js";

export type PackagedDesktopRootIdentity = {
  appPath: string;
  descriptor: RuntimeDescriptor;
  executablePath: string;
  logPath: string;
  namespaceRoot: string;
  pid: number;
  ppid: number;
  stamp: SidecarStamp;
  startedAt: string;
  updatedAt: string;
  version: 1;
};

export type PackagedWebRootIdentity = {
  descriptor: RuntimeDescriptor;
  namespace: string;
  pid: number;
  url: string;
  startedAt: string;
  version: 1;
};

export type PackagedDesktopIdentityHandle = {
  close(): Promise<void>;
  identity: PackagedDesktopRootIdentity;
};

function resolveCurrentMacAppPath(executablePath: string): string {
  return dirname(dirname(dirname(executablePath)));
}

function createPackagedDesktopRootIdentity(options: {
  descriptor: RuntimeDescriptor;
  paths: PackagedNamespacePaths;
  stamp: SidecarStamp;
}): PackagedDesktopRootIdentity {
  const now = new Date().toISOString();
  const executablePath = process.execPath;

  return {
    appPath: resolveCurrentMacAppPath(executablePath),
    descriptor: options.descriptor,
    executablePath,
    logPath: options.paths.desktopLogPath,
    namespaceRoot: options.paths.namespaceRoot,
    pid: process.pid,
    ppid: process.ppid,
    stamp: options.stamp,
    startedAt: now,
    updatedAt: now,
    version: 1,
  };
}

// @dsp func-6dac2721
export async function writePackagedDesktopIdentity(options: {
  descriptor: RuntimeDescriptor;
  identityPath?: string;
  paths: PackagedNamespacePaths;
  stamp: SidecarStamp;
}): Promise<PackagedDesktopIdentityHandle> {
  const identity = createPackagedDesktopRootIdentity(options);
  const identityPath = options.identityPath ?? options.paths.desktopIdentityPath;

  const writeIdentity = async () => {
    identity.updatedAt = new Date().toISOString();
    await writeJsonFile(identityPath, identity);
  };

  await writeIdentity();
  const heartbeat = setInterval(() => {
    void writeIdentity().catch(() => undefined);
  }, 5000);
  heartbeat.unref();

  return {
    async close() {
      clearInterval(heartbeat);
      await removeFile(identityPath).catch(() => undefined);
    },
    identity,
  };
}

// @dsp func-fb14aa78
export async function writePackagedWebIdentity(options: {
  descriptor: RuntimeDescriptor;
  paths: PackagedNamespacePaths;
  pid: number;
  url: string;
}): Promise<void> {
  const identity: PackagedWebRootIdentity = {
    descriptor: options.descriptor,
    namespace: options.paths.namespaceRoot.split("/").pop() ?? "default",
    pid: options.pid,
    url: options.url,
    startedAt: new Date().toISOString(),
    version: 1,
  };
  await writeJsonFile(options.paths.webIdentityPath, identity);
}
