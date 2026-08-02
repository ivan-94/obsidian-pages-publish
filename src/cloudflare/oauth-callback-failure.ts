/** A trusted, non-secret explanation that can be shown in the browser callback. */
export class CloudflareOAuthCallbackFailure extends Error {
  readonly name = 'CloudflareOAuthCallbackFailure';

  constructor(readonly browserMessage: string) {
    super(browserMessage);
  }
}
