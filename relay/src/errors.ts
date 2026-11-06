/** A failure with the HTTP status it should produce. Messages never echo submitted values. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
