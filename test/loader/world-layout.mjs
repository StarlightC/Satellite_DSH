// Path layout of one Loader test world, kept free of Git and DSH imports so a
// unit test can check the isolation structure without building the world.
import { join, relative, isAbsolute } from 'node:path'

/**
 * @param {string} root - absolute temporary world root.
 * @returns paths of the DSH home, its session root (the base row's
 *   `dshHomePath('sessions')`), the profile, and the Git repo used as cwd.
 */
export function worldLayout(root) {
  if (!isAbsolute(root)) throw new Error(`world root must be absolute: ${root}`)
  const home = join(root, 'home')
  return {
    root,
    home,
    sessions: join(home, 'sessions'),
    profileDir: join(home, 'profiles', 'satellite-test'),
    repo: join(root, 'repo'),
  }
}

/** True when `path` is `dir` itself or lies inside it. */
export function isInside(dir, path) {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
