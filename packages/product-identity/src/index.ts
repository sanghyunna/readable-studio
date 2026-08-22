export const PRODUCT_ID = "readable-studio";
export const PRODUCT_NAME = "Readable Studio";
export const REPOSITORY_URL = "https://github.com/sanghyunna/readable-studio";
export const DESKTOP_APP_ID = "studio.readable.desktop";
export const CLI_NAME = "readable";
export const PACKAGE_SCOPE = "@readable-studio";
export const ENV_PREFIX = "READABLE_";
export const URL_SCHEME = "readable-studio://";
export const HOST_GLOBAL = "__readableStudio__";
export const PROJECT_DATA_DIR_NAME = ".readable-studio";
export const USER_DATA_DIR_NAME = "Readable Studio";
export const PLUGIN_MANIFEST_NAME = "readable-studio.json";
export const PLUGIN_METADATA_PREFIX = "readable.";

export type ProductIdentity = {
  readonly productId: typeof PRODUCT_ID;
  readonly productName: typeof PRODUCT_NAME;
  readonly repositoryUrl: typeof REPOSITORY_URL;
  readonly appId: typeof DESKTOP_APP_ID;
  readonly cliName: typeof CLI_NAME;
  readonly packageScope: typeof PACKAGE_SCOPE;
  readonly envPrefix: typeof ENV_PREFIX;
  readonly urlScheme: typeof URL_SCHEME;
  readonly hostGlobal: typeof HOST_GLOBAL;
  readonly projectDataDirName: typeof PROJECT_DATA_DIR_NAME;
  readonly userDataDirName: typeof USER_DATA_DIR_NAME;
  readonly pluginManifestName: typeof PLUGIN_MANIFEST_NAME;
  readonly pluginMetadataPrefix: typeof PLUGIN_METADATA_PREFIX;
};

export const PRODUCT_IDENTITY = {
  productId: PRODUCT_ID,
  productName: PRODUCT_NAME,
  repositoryUrl: REPOSITORY_URL,
  appId: DESKTOP_APP_ID,
  cliName: CLI_NAME,
  packageScope: PACKAGE_SCOPE,
  envPrefix: ENV_PREFIX,
  urlScheme: URL_SCHEME,
  hostGlobal: HOST_GLOBAL,
  projectDataDirName: PROJECT_DATA_DIR_NAME,
  userDataDirName: USER_DATA_DIR_NAME,
  pluginManifestName: PLUGIN_MANIFEST_NAME,
  pluginMetadataPrefix: PLUGIN_METADATA_PREFIX,
} as const satisfies ProductIdentity;

const PRODUCT_IDENTITY_FIELDS = [
  "productId",
  "productName",
  "repositoryUrl",
  "appId",
  "cliName",
  "packageScope",
  "envPrefix",
  "urlScheme",
  "hostGlobal",
  "projectDataDirName",
  "userDataDirName",
  "pluginManifestName",
  "pluginMetadataPrefix",
] as const;

type ProductIdentityField = (typeof PRODUCT_IDENTITY_FIELDS)[number];

export const PRODUCT_IDENTITY_ERROR_CODES = {
  INVALID_SHAPE: "invalid_shape",
  MALFORMED_VALUE: "malformed_value",
  MISSING_FIELD: "missing_field",
  NONCANONICAL_VALUE: "noncanonical_value",
  UNEXPECTED_FIELD: "unexpected_field",
} as const;

export type ProductIdentityErrorCode =
  (typeof PRODUCT_IDENTITY_ERROR_CODES)[keyof typeof PRODUCT_IDENTITY_ERROR_CODES];

export class ProductIdentityParseError extends Error {
  readonly name = "ProductIdentityParseError";

  constructor(
    readonly code: ProductIdentityErrorCode,
    readonly field: string | null,
    message: string,
  ) {
    super(message);
  }
}

function assertNever(value: never): never {
  throw new ProductIdentityParseError("invalid_shape", null, `unsupported identity field: ${String(value)}`);
}

function isMalformed(field: ProductIdentityField, value: string): boolean {
  switch (field) {
    case "productId":
    case "cliName":
      return !/^[a-z][a-z0-9-]*$/.test(value);
    case "productName":
    case "userDataDirName":
      return value.length === 0 || value.trim() !== value;
    case "repositoryUrl":
      return !/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value);
    case "appId":
      return !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/.test(value);
    case "packageScope":
      return !/^@[a-z][a-z0-9-]*$/.test(value);
    case "envPrefix":
      return !/^[A-Z][A-Z0-9]*_$/.test(value);
    case "urlScheme":
      return !/^[a-z][a-z0-9+.-]*:\/\/$/.test(value);
    case "hostGlobal":
      return !/^__[A-Za-z][A-Za-z0-9]*__$/.test(value);
    case "projectDataDirName":
      return !/^\.[a-z][a-z0-9-]*$/.test(value);
    case "pluginManifestName":
      return !/^[a-z][a-z0-9-]*\.json$/.test(value);
    case "pluginMetadataPrefix":
      return !/^[a-z][a-z0-9-]*\.$/.test(value);
    default:
      return assertNever(field);
  }
}

function readCanonicalField<TField extends ProductIdentityField>(
  input: object,
  field: TField,
): ProductIdentity[TField] {
  if (!Object.hasOwn(input, field)) {
    throw new ProductIdentityParseError("missing_field", field, `product identity is missing ${field}`);
  }
  const value = Reflect.get(input, field);
  if (typeof value !== "string" || isMalformed(field, value)) {
    throw new ProductIdentityParseError("malformed_value", field, `product identity ${field} is malformed`);
  }
  const canonicalValue = PRODUCT_IDENTITY[field];
  if (value !== canonicalValue) {
    throw new ProductIdentityParseError(
      "noncanonical_value",
      field,
      `product identity ${field} must be ${JSON.stringify(canonicalValue)}`,
    );
  }
  return canonicalValue;
}

export function parseProductIdentity(input: unknown): ProductIdentity {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProductIdentityParseError("invalid_shape", null, "product identity must be an object");
  }
  const allowedFields = new Set<string>(PRODUCT_IDENTITY_FIELDS);
  const unexpectedField = Object.keys(input)
    .filter((field) => !allowedFields.has(field))
    .sort()[0];
  if (unexpectedField !== undefined) {
    throw new ProductIdentityParseError(
      "unexpected_field",
      unexpectedField,
      `product identity contains unexpected field ${unexpectedField}`,
    );
  }

  return {
    productId: readCanonicalField(input, "productId"),
    productName: readCanonicalField(input, "productName"),
    repositoryUrl: readCanonicalField(input, "repositoryUrl"),
    appId: readCanonicalField(input, "appId"),
    cliName: readCanonicalField(input, "cliName"),
    packageScope: readCanonicalField(input, "packageScope"),
    envPrefix: readCanonicalField(input, "envPrefix"),
    urlScheme: readCanonicalField(input, "urlScheme"),
    hostGlobal: readCanonicalField(input, "hostGlobal"),
    projectDataDirName: readCanonicalField(input, "projectDataDirName"),
    userDataDirName: readCanonicalField(input, "userDataDirName"),
    pluginManifestName: readCanonicalField(input, "pluginManifestName"),
    pluginMetadataPrefix: readCanonicalField(input, "pluginMetadataPrefix"),
  };
}

export function serializeProductIdentity(identity: ProductIdentity): string {
  return `${JSON.stringify(identity, null, 2)}\n`;
}
