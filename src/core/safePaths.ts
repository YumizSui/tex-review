import * as fs from 'fs';
import * as path from 'path';

export function validateReviewName(name: string): string {
  if (!name.trim() || name !== name.trim() || name.length > 120 ||
      /[\\/\x00-\x1f<>:"|?*]/.test(name) || name === '.' || name === '..') {
    throw new Error('Review names cannot contain paths or special characters.');
  }
  return name;
}

// The review store is local data, never a route to an arbitrary file.
export function rejectSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function workspaceFile(root: string, file: string): string {
  if (!file || path.isAbsolute(file) || file.includes('\\')) throw new Error('Invalid review file path');
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error('Review target must be inside the workspace');
  }
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (fs.existsSync(root)) {
    const actual = path.relative(fs.realpathSync(root), fs.realpathSync(existing));
    if (actual === '..' || actual.startsWith('..' + path.sep) || path.isAbsolute(actual)) {
      throw new Error('Review target resolves outside the workspace');
    }
  }
  return target;
}
