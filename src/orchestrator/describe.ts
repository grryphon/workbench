/**
 * A push to a branch the workbench does not own was refused because that branch has
 * moved on. Its own kind of failure because it is the one worth answering by taking the
 * branch in and pushing again — never by forcing, which would overwrite their work.
 * Here rather than beside the git that throws it, so the loop can know it without git.
 */
export class RemoteMoved extends Error {
  constructor(branch: string) {
    super(
      `${branch} has moved on since it was taken in, and the workbench never forces a ` +
        'push over somebody else’s work',
    );
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What would not merge, said so a person can act on it: the base is a commit and
 * is worth naming as one, and anything else is a ticket's branch, which says which
 * ticket without anybody having to look a sha up.
 */
export function describeRef(ref: string, base: string): string {
  return ref === base
    ? `${base.slice(0, 8)}, which the base has moved on to`
    : `${ref}, whose work it waits for`;
}
