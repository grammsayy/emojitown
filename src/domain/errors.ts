/**
 * An expected, member-facing rejection. The message explains the next useful
 * action and is shown privately. No state has changed when this is thrown.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
