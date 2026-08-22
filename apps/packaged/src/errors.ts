export class PackagedNetworkingRestoreError extends Error {
  readonly title = "Readable Studio could not restore networking";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PackagedNetworkingRestoreError";
  }
}

export class PackagedPathAccessError extends Error {
  readonly title: string;

  constructor(message: string, options?: { cause?: unknown; title?: string }) {
    super(message, options);
    this.name = "PackagedPathAccessError";
    this.title = options?.title ?? "Readable Studio cannot access its data folder";
  }
}
