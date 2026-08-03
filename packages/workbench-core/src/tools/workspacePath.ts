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
 * Resolve a tool path beneath the configured workspace, following any existing
 * symlinks/junctions before returning it. Missing descendants are rebuilt from
 * their nearest real ancestor so an existing link cannot redirect the access.
 */
export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const workspace = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspace, requestedPath);

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
