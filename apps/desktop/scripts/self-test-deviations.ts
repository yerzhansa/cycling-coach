export function deviationMap(source: string): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  let metric: string | undefined;
  let status: string | undefined;
  let paths: string[] = [];
  let readingPaths = false;
  const commit = (): void => {
    if (status === "pending") throw new Error("pending deviation");
    if (metric !== undefined) map.set(metric, status === "approved-cite" ? [...paths] : []);
  };
  for (const line of source.split(/\r?\n/u)) {
    const metricMatch = /^  - metric: (\S+)$/u.exec(line);
    if (metricMatch !== null) {
      commit();
      metric = metricMatch[1];
      status = undefined;
      paths = [];
      readingPaths = false;
      continue;
    }
    const statusMatch = /^    status: (\S+)$/u.exec(line);
    if (statusMatch !== null) {
      status = statusMatch[1];
      readingPaths = false;
      continue;
    }
    if (line === "    added_paths:") {
      readingPaths = true;
      continue;
    }
    const pathMatch = readingPaths ? /^      - (\S+)$/u.exec(line) : null;
    if (pathMatch !== null) {
      paths.push(pathMatch[1]!);
      continue;
    }
    if (readingPaths && !line.startsWith("      ")) readingPaths = false;
  }
  commit();
  return map;
}
