export interface PackagePlanInput<BuilderConfig> {
  readonly desktopRoot: string;
  readonly outputDirectory: string;
  readonly applicationRelativePath: string;
  readonly executableRelativePath: string;
  readonly builderConfig: BuilderConfig;
}

export interface PackageBuilderOptions<BuilderConfig> {
  readonly projectDir: string;
  readonly publish: "never";
  readonly config: BuilderConfig;
}

export interface PackagePlan<BuilderConfig> {
  readonly applicationPath: string;
  readonly executablePath: string;
  readonly outputPath: string;
  readonly builderOptions: PackageBuilderOptions<BuilderConfig>;
}

export function contained(root: string, path: string): boolean;

export function createPackagePlan<BuilderConfig>(
  input: PackagePlanInput<BuilderConfig>,
): PackagePlan<BuilderConfig>;
