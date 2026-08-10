import { isAbsolute, relative, resolve, sep } from "node:path";

export function contained(root, path) {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function resolveChild(root, path, relativeMessage, containmentMessage) {
  if (isAbsolute(path)) throw new TypeError(relativeMessage);
  const resolved = resolve(root, path);
  if (relative(root, resolved) === "" || !contained(root, resolved)) {
    throw new TypeError(containmentMessage);
  }
  return resolved;
}

export function createPackagePlan(input) {
  if (!isAbsolute(input.desktopRoot)) {
    throw new TypeError("desktop root must be absolute");
  }
  const outputPath = resolveChild(
    input.desktopRoot,
    input.outputDirectory,
    "package output directory must be relative",
    "package output directory must be inside desktop root",
  );
  const applicationPath = resolveChild(
    outputPath,
    input.applicationRelativePath,
    "application path must be relative to package output",
    "application path must be inside package output",
  );
  const executablePath = resolveChild(
    applicationPath,
    input.executableRelativePath,
    "executable path must be relative to application",
    "executable path must be inside application",
  );
  return Object.freeze({
    applicationPath,
    executablePath,
    outputPath,
    builderOptions: {
      projectDir: input.desktopRoot,
      publish: "never",
      config: input.builderConfig,
    },
  });
}
