import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const changelogPath = resolve(projectRoot, "CHANGELOG.md");
const packageJsonPath = resolve(projectRoot, "package.json");
const defaultNotesPath = resolve(projectRoot, ".release-notes.md");

function parseArgs(argv) {
  const options = {
    dryRun: false,
    previousTag: undefined,
    version: undefined,
    date: undefined,
    notesFile: defaultNotesPath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (value === "--previous-tag") {
      options.previousTag = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--version") {
      options.version = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--date") {
      options.date = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--notes-file") {
      options.notesFile = resolve(projectRoot, argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

function readPackageVersion() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getPreviousTag(explicitTag) {
  if (explicitTag) {
    return explicitTag;
  }

  try {
    return runGit(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    return null;
  }
}

function getCommitSubjects(previousTag) {
  const rangeArgs = previousTag
    ? [`${previousTag}..HEAD`]
    : ["HEAD"];
  const output = runGit([
    "log",
    "--first-parent",
    "--pretty=format:%s",
    ...rangeArgs,
  ]);

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^chore\(release\):\s+v\d+\.\d+\.\d+/u.test(line));
}

function buildSection(version, date, subjects, previousTag) {
  const header = `## v${version} - ${date}`;
  const bullets =
    subjects.length > 0
      ? subjects.map((subject) => `- ${subject}`).join("\n")
      : `- No source changes recorded since ${previousTag ?? "the initial release baseline"}.`;

  return `${header}\n\n${bullets}\n`;
}

function normalizeHeader(content) {
  if (content.startsWith("# Changelog\n")) {
    return content;
  }

  const intro = [
    "# Changelog",
    "",
    "All notable changes to this project will be documented in this file.",
    "",
  ].join("\n");

  return `${intro}${content.trimStart()}`;
}

function removeExistingSection(content, version) {
  const marker = `\n## v${version} - `;
  const start = content.indexOf(marker);

  if (start === -1) {
    return content;
  }

  const nextSectionStart = content.indexOf("\n## v", start + marker.length);
  const end = nextSectionStart === -1 ? content.length : nextSectionStart;
  return `${content.slice(0, start)}\n${content.slice(end)}`;
}

function upsertChangelog(content, section, version) {
  const normalized = normalizeHeader(content);
  const withoutExisting = removeExistingSection(normalized, version);
  const header = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";
  const rest = withoutExisting
    .replace(
      /^# Changelog\n\nAll notable changes to this project will be documented in this file\.\n*/u,
      "",
    )
    .trimStart();
  return `${header}${section}\n${rest}`.trimEnd() + "\n";
}

const options = parseArgs(process.argv.slice(2));
const version = options.version ?? readPackageVersion();
const releaseDate = options.date ?? new Date().toISOString().slice(0, 10);
const previousTag = getPreviousTag(options.previousTag);
const commitSubjects = getCommitSubjects(previousTag);
const section = buildSection(version, releaseDate, commitSubjects, previousTag);
const currentContent = existsSync(changelogPath)
  ? readFileSync(changelogPath, "utf8")
  : "";
const nextContent = upsertChangelog(currentContent, section, version);

writeFileSync(options.notesFile, section, "utf8");

if (!options.dryRun) {
  writeFileSync(changelogPath, nextContent, "utf8");
}

process.stdout.write(
  `${options.dryRun ? "Previewed" : "Updated"} changelog for v${version} using ${previousTag ?? "repository history"}.\n`,
);
