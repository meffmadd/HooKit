import { basename, dirname, join } from "node:path";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { CatalogStorageLocations } from "./hook-catalog/index.js";

/** Pi's configured project directory name (normally `.pi`). */
export function configDirName(): string {
  const config = PiCodingAgent as typeof PiCodingAgent & {
    CONFIG_DIR_NAME?: string;
  };
  return config.CONFIG_DIR_NAME ?? basename(dirname(config.getAgentDir()));
}

/** Resolve the project hook storage path for a given cwd. */
export function projectFilePath(cwd: string): string {
  return join(cwd, configDirName(), "hookit.json");
}

/** Resolve the user-level hook storage path. */
export function globalFilePath(): string {
  return join(PiCodingAgent.getAgentDir(), "hookit.json");
}

/** Build the exact storage set authorized by Pi-facing trust policy. */
export function catalogStorageLocations(
  cwd: string,
  projectTrusted: boolean,
): CatalogStorageLocations {
  return {
    global: globalFilePath(),
    ...(projectTrusted ? { project: projectFilePath(cwd) } : {}),
  };
}
