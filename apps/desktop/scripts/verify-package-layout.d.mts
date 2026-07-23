export interface BuilderAuthority {
  readonly asarSourceRoot: string;
  readonly externalSourceRoot: string;
}

export interface PackageLayoutOptions {
  readonly desktopRoot?: string;
}

export function readBuilderAuthority(desktopRoot?: string): Promise<BuilderAuthority>;

export function verifyPackageLayout(
  application: string,
  options?: PackageLayoutOptions,
): Promise<void>;
