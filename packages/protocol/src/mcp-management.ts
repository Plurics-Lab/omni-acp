import { z } from "zod";
import { McpServerPreset } from "./config.js";
import type { AuthContext } from "./contracts.js";

export const McpResourceName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
export const McpInstallationId = z.string().regex(/^[a-f0-9]{64}$/);
const strings = z.array(z.string().max(8192)).max(128).default([]);
const env = z.record(z.string().max(256), z.string().max(8192)).default({});
export const RegisterMcpPresetRequest = z.union([
  z.strictObject({ name: McpResourceName, server: McpServerPreset }),
  z.strictObject({ name: McpResourceName, installationId: McpInstallationId, args: strings, env }),
]);
export type RegisterMcpPresetRequest = z.input<typeof RegisterMcpPresetRequest>;
export const InstallMcpRequest = z.strictObject({
  name: McpResourceName,
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/),
  runtime: z.enum(["native", "node", "bun", "python3"]),
  entrypoint: z.string().min(1).max(512),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(512),
        dataBase64: z.string(),
        sha256: McpInstallationId,
      }),
    )
    .min(1)
    .max(1024),
});
export type InstallMcpRequest = z.input<typeof InstallMcpRequest>;
export interface McpPresetMetadata {
  name: string;
  type: "stdio" | "http" | "sse";
  source: "static" | "managed";
  installationId?: string;
  createdAt?: string;
}
export interface McpInstallationMetadata {
  id: string;
  name: string;
  version: string;
  runtime: "native" | "node" | "bun" | "python3";
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}
export interface McpManagement {
  /** Checked before HTTP body consumption, and again by mutation methods. */
  assertMutation(auth: AuthContext, kind: "manage" | "install"): void;
  listPresets(auth: AuthContext): Promise<{ presets: McpPresetMetadata[] }>;
  getPreset(auth: AuthContext, name: string): Promise<McpPresetMetadata>;
  registerPreset(auth: AuthContext, request: RegisterMcpPresetRequest): Promise<McpPresetMetadata>;
  removePreset(auth: AuthContext, name: string): Promise<void>;
  listInstallations(auth: AuthContext): Promise<{ installations: McpInstallationMetadata[] }>;
  getInstallation(auth: AuthContext, id: string): Promise<McpInstallationMetadata>;
  install(auth: AuthContext, request: InstallMcpRequest): Promise<McpInstallationMetadata>;
}

/** Strict on-disk records, also validated at boot; no unchecked JSON casts. */
export const ManagedMcpPresetRecord = z.strictObject({
  meta: z.strictObject({
    name: McpResourceName,
    type: z.enum(["stdio", "http", "sse"]),
    source: z.literal("managed"),
    installationId: McpInstallationId.optional(),
    createdAt: z.string().datetime(),
  }),
  server: McpServerPreset,
  deleted: z.boolean(),
});
export const ManagedMcpInstallationRecord = z.strictObject({
  meta: z.strictObject({
    id: McpInstallationId,
    name: McpResourceName,
    version: InstallMcpRequest.shape.version,
    runtime: InstallMcpRequest.shape.runtime,
    fileCount: z.number().int().positive().max(1024),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    createdAt: z.string().datetime(),
  }),
  entrypoint: z.string().min(1).max(512),
  files: z
    .array(z.strictObject({ path: z.string().min(1).max(512), sha256: McpInstallationId }))
    .min(1)
    .max(1024),
});
