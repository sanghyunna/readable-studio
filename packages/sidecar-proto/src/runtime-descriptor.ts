import { DESKTOP_APP_ID, PRODUCT_ID } from "@readable-studio/product-identity";

export const RUNTIME_APP_ID = DESKTOP_APP_ID;
export const RUNTIME_PRODUCT_ID = PRODUCT_ID;
export const RUNTIME_DESCRIPTOR_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_DESCRIPTOR_VERSION = 1 as const;
export const PRODUCT_DESCRIPTOR_HASH = "9d1181594e3733ae67c685c6e1529baa1f095a19d93ec9739445a15643ab0c3a" as const;
export const PRODUCT_DESCRIPTOR_IDENTITY = {
  appId: RUNTIME_APP_ID,
  productId: RUNTIME_PRODUCT_ID,
  protocolVersion: RUNTIME_DESCRIPTOR_PROTOCOL_VERSION,
  runtimeVersion: RUNTIME_DESCRIPTOR_VERSION,
} as const;

const RUNTIME_DESCRIPTOR_FIELDS = [
  "appId",
  "appVersion",
  "descriptorHash",
  "productId",
  "protocolVersion",
  "runtimeVersion",
] as const;

export type RuntimeDescriptor = {
  readonly appId: typeof DESKTOP_APP_ID;
  readonly appVersion: string;
  readonly descriptorHash: typeof PRODUCT_DESCRIPTOR_HASH;
  readonly productId: typeof PRODUCT_ID;
  readonly protocolVersion: typeof RUNTIME_DESCRIPTOR_PROTOCOL_VERSION;
  readonly runtimeVersion: typeof RUNTIME_DESCRIPTOR_VERSION;
};

export class RuntimeDescriptorError extends Error {
  readonly name = "RuntimeDescriptorError";
}

function readField(input: object, field: (typeof RUNTIME_DESCRIPTOR_FIELDS)[number]): unknown {
  if (!Object.hasOwn(input, field)) {
    throw new RuntimeDescriptorError(`runtime descriptor is missing ${field}`);
  }
  return Reflect.get(input, field);
}

function normalizeAppVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new RuntimeDescriptorError("runtime descriptor appVersion must be a non-empty trimmed string");
  }
  return value;
}

function requireCanonical<T>(field: string, value: unknown, expected: T): T {
  if (value !== expected) {
    throw new RuntimeDescriptorError(`runtime descriptor ${field} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

export function createRuntimeDescriptor(appVersion: string): RuntimeDescriptor {
  return {
    appId: DESKTOP_APP_ID,
    appVersion: normalizeAppVersion(appVersion),
    descriptorHash: PRODUCT_DESCRIPTOR_HASH,
    productId: PRODUCT_ID,
    protocolVersion: RUNTIME_DESCRIPTOR_PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_DESCRIPTOR_VERSION,
  };
}

export function normalizeRuntimeDescriptor(input: unknown): RuntimeDescriptor {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RuntimeDescriptorError("runtime descriptor must be an object");
  }
  const allowedFields = new Set<string>(RUNTIME_DESCRIPTOR_FIELDS);
  const unexpectedField = Object.keys(input).filter((field) => !allowedFields.has(field)).sort()[0];
  if (unexpectedField !== undefined) {
    throw new RuntimeDescriptorError(`runtime descriptor contains unexpected field ${unexpectedField}`);
  }
  return {
    appId: requireCanonical("appId", readField(input, "appId"), DESKTOP_APP_ID),
    appVersion: normalizeAppVersion(readField(input, "appVersion")),
    descriptorHash: requireCanonical(
      "descriptorHash",
      readField(input, "descriptorHash"),
      PRODUCT_DESCRIPTOR_HASH,
    ),
    productId: requireCanonical("productId", readField(input, "productId"), PRODUCT_ID),
    protocolVersion: requireCanonical(
      "protocolVersion",
      readField(input, "protocolVersion"),
      RUNTIME_DESCRIPTOR_PROTOCOL_VERSION,
    ),
    runtimeVersion: requireCanonical(
      "runtimeVersion",
      readField(input, "runtimeVersion"),
      RUNTIME_DESCRIPTOR_VERSION,
    ),
  };
}

export function serializeProductDescriptorIdentity(): string {
  return `${JSON.stringify(PRODUCT_DESCRIPTOR_IDENTITY)}\n`;
}

export function serializeRuntimeDescriptor(descriptor: RuntimeDescriptor): string {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}
