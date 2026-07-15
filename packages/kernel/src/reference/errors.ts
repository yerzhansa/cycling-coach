export class ReferenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceConfigError";
  }
}
