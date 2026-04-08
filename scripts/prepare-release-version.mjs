import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJsonPath = resolve(projectRoot, "package.json");
const packageLockPath = resolve(projectRoot, "package-lock.json");
const allowedBumps = new Set([
  "patch",
  "minor",
  "major",
  "prepatch",
  "preminor",
  "premajor",
  "prerelease"
]);

function parseArgs(argv) {
  const options = {
    bumpType: "patch",
    previewOnly: false
  };

  for (const value of argv) {
    if (value === "--preview-only") {
      options.previewOnly = true;
      continue;
    }

    if (value.startsWith("--")) {
      throw new Error(`Unknown argument: ${value}`);
    }

    options.bumpType = value;
  }

  return options;
}

function readPackageVersion(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8")).version;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, {
      encoding: "utf8",
      flag: "a"
    });
  }
}

function computePreviewVersion(bumpType) {
  const tempDir = mkdtempSync(resolve(tmpdir(), "agentic-task-kit-release-"));

  try {
    cpSync(packageJsonPath, resolve(tempDir, "package.json"));
    cpSync(packageLockPath, resolve(tempDir, "package-lock.json"));

    execFileSync("npm", ["version", bumpType, "--no-git-tag-version"], {
      cwd: tempDir,
      stdio: "ignore"
    });

    return readPackageVersion(resolve(tempDir, "package.json"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
const bumpType = options.bumpType;

if (!allowedBumps.has(bumpType)) {
  throw new Error(
    `Unsupported version bump type: ${bumpType}. Expected one of ${Array.from(allowedBumps).join(", ")}.`
  );
}

const previousVersion = readPackageVersion(packageJsonPath);
const nextVersion = options.previewOnly
  ? computePreviewVersion(bumpType)
  : (() => {
      execFileSync("npm", ["version", bumpType, "--no-git-tag-version"], {
        cwd: projectRoot,
        stdio: "inherit"
      });

      const version = readPackageVersion(packageJsonPath);
      const packageLockVersion = readPackageVersion(packageLockPath);

      if (packageLockVersion !== version) {
        throw new Error(
          `package-lock.json version mismatch after bump. package.json=${version}, package-lock.json=${packageLockVersion}`
        );
      }

      return version;
    })();

const releaseTag = `v${nextVersion}`;

writeOutput("previous_version", previousVersion);
writeOutput("version", nextVersion);
writeOutput("tag", releaseTag);

process.stdout.write(
  `${options.previewOnly ? "Previewed" : "Prepared"} release version bump: ${previousVersion} -> ${nextVersion} (${releaseTag})\n`
);
