import { describe, expect, it } from "vitest";

import {
  CLI_NAME,
  DESKTOP_APP_ID,
  ENV_PREFIX,
  HOST_GLOBAL,
  PACKAGE_SCOPE,
  PLUGIN_MANIFEST_NAME,
  PLUGIN_METADATA_PREFIX,
  PRODUCT_ID,
  PRODUCT_IDENTITY,
  PRODUCT_NAME,
  PROJECT_DATA_DIR_NAME,
  ProductIdentityParseError,
  REPOSITORY_URL,
  serializeProductIdentity,
  parseProductIdentity,
  URL_SCHEME,
  USER_DATA_DIR_NAME,
} from "../src/index.js";

const expectedIdentity = {
  productId: "readable-studio",
  productName: "Readable Studio",
  repositoryUrl: "https://github.com/sanghyunna/readable-studio",
  appId: "studio.readable.desktop",
  cliName: "readable",
  packageScope: "@readable-studio",
  envPrefix: "READABLE_",
  urlScheme: "readable-studio://",
  hostGlobal: "__readableStudio__",
  projectDataDirName: ".readable-studio",
  userDataDirName: "Readable Studio",
  pluginManifestName: "readable-studio.json",
  pluginMetadataPrefix: "readable.",
} as const;

function expectParseError(
  input: unknown,
  code: ProductIdentityParseError["code"],
  field: ProductIdentityParseError["field"],
): void {
  try {
    parseProductIdentity(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ProductIdentityParseError);
    if (error instanceof ProductIdentityParseError) {
      expect({ code: error.code, field: error.field }).toEqual({ code, field });
      return;
    }
    throw error;
  }
  expect.fail("expected product identity parsing to fail");
}

describe("Readable Studio product identity", () => {
  it("exports every canonical machine identity value", () => {
    expect({
      PRODUCT_ID,
      PRODUCT_NAME,
      REPOSITORY_URL,
      DESKTOP_APP_ID,
      CLI_NAME,
      PACKAGE_SCOPE,
      ENV_PREFIX,
      URL_SCHEME,
      HOST_GLOBAL,
      PROJECT_DATA_DIR_NAME,
      USER_DATA_DIR_NAME,
      PLUGIN_MANIFEST_NAME,
      PLUGIN_METADATA_PREFIX,
    }).toEqual({
      PRODUCT_ID: expectedIdentity.productId,
      PRODUCT_NAME: expectedIdentity.productName,
      REPOSITORY_URL: expectedIdentity.repositoryUrl,
      DESKTOP_APP_ID: expectedIdentity.appId,
      CLI_NAME: expectedIdentity.cliName,
      PACKAGE_SCOPE: expectedIdentity.packageScope,
      ENV_PREFIX: expectedIdentity.envPrefix,
      URL_SCHEME: expectedIdentity.urlScheme,
      HOST_GLOBAL: expectedIdentity.hostGlobal,
      PROJECT_DATA_DIR_NAME: expectedIdentity.projectDataDirName,
      USER_DATA_DIR_NAME: expectedIdentity.userDataDirName,
      PLUGIN_MANIFEST_NAME: expectedIdentity.pluginManifestName,
      PLUGIN_METADATA_PREFIX: expectedIdentity.pluginMetadataPrefix,
    });
    expect(PRODUCT_IDENTITY).toEqual(expectedIdentity);
  });

  it("serializes deterministically and parses the exact JSON shape", () => {
    const serialized = serializeProductIdentity(PRODUCT_IDENTITY);

    expect(serialized).toBe(`${JSON.stringify(expectedIdentity, null, 2)}\n`);
    expect(parseProductIdentity(JSON.parse(serialized))).toEqual(expectedIdentity);
    expect(serializeProductIdentity(parseProductIdentity(JSON.parse(serialized)))).toBe(serialized);
  });

  it("rejects invalid descriptors", () => {
    const { appId: _appId, ...missingAppId } = expectedIdentity;
    expectParseError(missingAppId, "missing_field", "appId");
    expectParseError({ ...expectedIdentity, productId: "foreign-product" }, "noncanonical_value", "productId");
    expectParseError({ ...expectedIdentity, urlScheme: "readable-studio:" }, "malformed_value", "urlScheme");
    expectParseError({ ...expectedIdentity, envPrefix: "READABLE" }, "malformed_value", "envPrefix");
    expectParseError({ ...expectedIdentity, packageScope: "readable-studio" }, "malformed_value", "packageScope");
    expectParseError({ ...expectedIdentity, extra: true }, "unexpected_field", "extra");
    expectParseError([expectedIdentity], "invalid_shape", null);
  });
});
