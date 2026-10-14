import * as fs from "fs";
import * as path from "path";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * A relative path that starts with the workspace folder's own name, when the
 * workspace has no subfolder of that name, is the model naming the workspace
 * rather than a directory inside it ("project/src/parse.js" for a workspace
 * called "project"). The live 1.7.0 rehearsal lost a whole task to this:
 * every read came back ENOENT and the worker looped. The segment is dropped
 * only in that unambiguous case; a real subfolder with the workspace's name
 * is addressed as written.
 */
export function stripWorkspaceFolderPrefix(workspace: string, requestedPath: string): string {
  const name = path.basename(workspace);
  if (!name) return requestedPath;
  const segments = requestedPath.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length < 1 || segments[0] !== name) return requestedPath;
  const ownNamedChild = path.join(workspace, name);
  try {
    if (fs.statSync(ownNamedChild).isDirectory()) return requestedPath;
  } catch { /* no subfolder of the workspace's own name: the prefix is the workspace itself */ }
  // "project" alone, for a workspace called "project", is the workspace root
  // (live: `list_directory "project"` came back ENOENT on every attempt).
  return segments.slice(1).join(path.sep) || ".";
}

/**
 * Resolve a tool path beneath the configured workspace, following any existing
 * symlinks/junctions before returning it. Missing descendants are rebuilt from
 * their nearest real ancestor so an existing link cannot redirect the access.
 */
export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const workspace = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspace, stripWorkspaceFolderPrefix(workspace, requestedPath));

  if (!isWithin(workspace, candidate)) {
    throw new Error(`Path is outside the workspace: ${requestedPath}`);
  }

  const realWorkspace = fs.realpathSync.native(workspace);
  let existingAncestor = candidate;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Unable to resolve workspace path: ${requestedPath}`);
    }
    existingAncestor = parent;
  }

  const realAncestor = fs.realpathSync.native(existingAncestor);
  if (!isWithin(realWorkspace, realAncestor)) {
    throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
  }

  const unresolvedTail = path.relative(existingAncestor, candidate);
  const resolved = unresolvedTail ? path.join(realAncestor, unresolvedTail) : realAncestor;
  if (!isWithin(realWorkspace, resolved)) {
    throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
  }

  return resolved;
}
