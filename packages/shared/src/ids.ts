// Client-side id generation. Ids travel inside commands, so applying commands stays deterministic.

export class IdGen {
  private n = 0;

  /** `tag` must be unique per client session (the server hands one out on join). */
  constructor(private readonly tag: string) {}

  next(prefix: string): string {
    return `${prefix}${this.tag}_${(this.n++).toString(36)}`;
  }
}
