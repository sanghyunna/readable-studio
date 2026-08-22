import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBundledResourceTrees } from "../src/resources.js";

describe("copyBundledResourceTrees", () => {
  it("includes the full packaged resource catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-tools-pack-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "resources");

    try {
      const designTemplatePath = join(
        workspaceRoot,
        "design-templates",
        "orbit-general",
        "SKILL.md",
      );
      const samplePetPath = join(
        workspaceRoot,
        "assets",
        "community-pets",
        "sample",
        "pet.json",
      );
      const darioPetPath = join(
        workspaceRoot,
        "assets",
        "community-pets",
        "dario",
        "pet.json",
      );
      const clippitPetPath = join(workspaceRoot, "assets", "community-pets", "clippit", "pet.json");
      const communityRegistryPath = join(
        workspaceRoot,
        "plugins",
        "registry",
        "community",
        "readable-studio-marketplace.json",
      );
      await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
      // The skills/design-templates split (see specs/current/
      // skills-and-design-templates.md) added a separate top-level
      // `design-templates/` tree that copyBundledResourceTrees now also
      // bundles. Create it in the fixture so the recursive copy does not
      // fail with ENOENT.
      await mkdir(join(workspaceRoot, "design-templates", "orbit-general"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "design-systems", "sample"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "plugins", "_official", "sample"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "plugins", "registry", "community"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
      await mkdir(join(workspaceRoot, "assets", "community-pets", "sample"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "assets", "community-pets", "dario"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "assets", "community-pets", "clippit"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "data", "plugin-previews"), {
        recursive: true,
      });
      await writeFile(
        join(workspaceRoot, "data", "plugin-previews", "manifest.json"),
        "{\"previews\":{}}\n",
        "utf8",
      );
      await writeFile(designTemplatePath, "# Orbit General\n", "utf8");
      await writeFile(samplePetPath, "{\"name\":\"sample\"}\n", "utf8");
      await writeFile(darioPetPath, "{\"name\":\"dario\"}\n", "utf8");
      await writeFile(clippitPetPath, "{\"name\":\"clippit\"}\n", "utf8");
      await writeFile(
        join(workspaceRoot, "plugins", "_official", "sample", "readable-studio.json"),
        "{\"id\":\"sample\"}\n",
        "utf8",
      );
      await writeFile(communityRegistryPath, "{\"plugins\":[]}\n", "utf8");

      await copyBundledResourceTrees({ workspaceRoot, resourceRoot });

      // The baked plugin-preview manifest must land under data/plugin-previews so
      // the packaged daemon can map plugins to their R2 clips; without it the
      // gallery silently falls back to live iframes.
      await expect(
        readFile(
          join(resourceRoot, "data", "plugin-previews", "manifest.json"),
          "utf8",
        ),
      ).resolves.toBe("{\"previews\":{}}\n");
      await expect(
        readFile(
          join(resourceRoot, "design-templates", "orbit-general", "SKILL.md"),
          "utf8",
        ),
      ).resolves.toBe("# Orbit General\n");
      await expect(
        readFile(
          join(resourceRoot, "community-pets", "sample", "pet.json"),
          "utf8",
        ),
      ).resolves.toBe("{\"name\":\"sample\"}\n");
      await expect(
        readFile(join(resourceRoot, "community-pets", "dario", "pet.json"), "utf8"),
      ).resolves.toBe("{\"name\":\"dario\"}\n");
      await expect(
        readFile(join(resourceRoot, "community-pets", "clippit", "pet.json"), "utf8"),
      ).resolves.toBe("{\"name\":\"clippit\"}\n");
      await expect(
        readFile(
          join(resourceRoot, "plugins", "_official", "sample", "readable-studio.json"),
          "utf8",
        ),
      ).resolves.toBe("{\"id\":\"sample\"}\n");
      await expect(
        readFile(
          join(
            resourceRoot,
            "plugins",
            "registry",
            "community",
            "readable-studio-marketplace.json",
          ),
          "utf8",
        ),
      ).resolves.toBe("{\"plugins\":[]}\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("includes the full community pet catalog in portable builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-tools-pack-portable-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "resources");

    try {
      await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "design-templates", "orbit-general"), { recursive: true });
      await mkdir(join(workspaceRoot, "design-systems", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "plugins", "_official", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "plugins", "registry", "community"), { recursive: true });
      await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
      await mkdir(join(workspaceRoot, "assets", "community-pets", "clippit"), { recursive: true });
      await mkdir(join(workspaceRoot, "assets", "community-pets", "dario"), { recursive: true });
      await mkdir(join(workspaceRoot, "data", "plugin-previews"), { recursive: true });

      await writeFile(join(workspaceRoot, "assets", "community-pets", "clippit", "pet.json"), "{\"name\":\"clippit\"}\n", "utf8");
      await writeFile(
        join(workspaceRoot, "assets", "community-pets", "clippit", "spritesheet.webp"),
        "clippit-sheet\n",
        "utf8",
      );
      await writeFile(join(workspaceRoot, "assets", "community-pets", "dario", "pet.json"), "{\"name\":\"dario\"}\n", "utf8");
      await writeFile(
        join(workspaceRoot, "assets", "community-pets", "dario", "spritesheet.webp"),
        "dario-sheet\n",
        "utf8",
      );
      await writeFile(join(workspaceRoot, "data", "plugin-previews", "manifest.json"), "{\"previews\":{}}\n", "utf8");
      await writeFile(join(workspaceRoot, "design-templates", "orbit-general", "SKILL.md"), "# Orbit General\n", "utf8");
      await writeFile(join(workspaceRoot, "plugins", "_official", "sample", "readable-studio.json"), "{\"id\":\"sample\"}\n", "utf8");
      await writeFile(join(workspaceRoot, "plugins", "registry", "community", "readable-studio-marketplace.json"), "{\"plugins\":[]}\n", "utf8");

      await copyBundledResourceTrees({
        workspaceRoot,
        resourceRoot,
      });

      await expect(readFile(join(resourceRoot, "community-pets", "clippit", "pet.json"), "utf8")).resolves.toBe(
        "{\"name\":\"clippit\"}\n",
      );
      await expect(
        readFile(join(resourceRoot, "community-pets", "clippit", "spritesheet.webp"), "utf8"),
      ).resolves.toBe("clippit-sheet\n");
      await expect(readFile(join(resourceRoot, "community-pets", "dario", "pet.json"), "utf8")).resolves.toBe(
        "{\"name\":\"dario\"}\n",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
