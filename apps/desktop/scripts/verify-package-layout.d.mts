export interface BuilderAuthority {
  readonly asarSourceRoot: string;
  readonly externalSourceRoot: string;
}

export interface PackageLayoutOptions {
  readonly desktopRoot?: string;
  readonly development?: true;
  readonly release?: {
    readonly version: string;
    readonly feedUrl: string;
  };
}

export function readBuilderAuthority(desktopRoot?: string): Promise<BuilderAuthority>;

export function verifyPackageLayout(
  application: string,
  options?: PackageLayoutOptions,
): Promise<void>;
