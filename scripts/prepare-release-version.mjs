import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

const bumpType = process.argv[2] ?? "patch";

if (!allowedBumps.has(bumpType)) {
  throw new Error(
    `Unsupported version bump type: ${bumpType}. Expected one of ${Array.from(allowedBumps).join(", ")}.`
  );
}

const previousVersion = readPackageVersion(packageJsonPath);

execFileSync("npm", ["version", bumpType, "--no-git-tag-version"], {
  cwd: projectRoot,
  stdio: "inherit"
});

const nextVersion = readPackageVersion(packageJsonPath);
const packageLockVersion = readPackageVersion(packageLockPath);

if (packageLockVersion !== nextVersion) {
  throw new Error(
    `package-lock.json version mismatch after bump. package.json=${nextVersion}, package-lock.json=${packageLockVersion}`
  );
}

const releaseTag = `v${nextVersion}`;

writeOutput("previous_version", previousVersion);
writeOutput("version", nextVersion);
writeOutput("tag", releaseTag);

process.stdout.write(
  `Prepared release version bump: ${previousVersion} -> ${nextVersion} (${releaseTag})\n`
);
