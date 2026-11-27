/** A folder tree of changed files, with single-child folder chains compacted ("src/components"). */
type TreeFile = { path: string; additions: number; deletions: number };
export type FileTreeNode<F extends TreeFile> =
  | { kind: "dir"; key: string; name: string; path: string; additions: number; deletions: number; children: FileTreeNode<F>[] }
  | { kind: "file"; key: string; name: string; file: F };

type Folder<F extends TreeFile> = { folders: Map<string, Folder<F>>; files: F[] };

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function buildFileTree<F extends TreeFile>(files: readonly F[], keyOf: (file: F) => string, prefix: string): FileTreeNode<F>[] {
  const root: Folder<F> = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, next = { folders: new Map(), files: [] });
      folder = next;
    }
    folder.files.push(file);
  }
  const convert = (folder: Folder<F>, base: string): FileTreeNode<F>[] => [
    ...[...folder.folders].sort(([left], [right]) => compare(left, right)).map(([name, child]): FileTreeNode<F> => {
      let label = name;
      let current = child;
      // A folder holding only one folder and no files is shown as one row.
      while (current.files.length === 0 && current.folders.size === 1) {
        const [[nextName, next]] = current.folders;
        label += "/" + nextName;
        current = next;
      }
      const path = base + label;
      const children = convert(current, path + "/");
      const totals = (nodes: FileTreeNode<F>[]): [number, number] => nodes.reduce<[number, number]>(([added, removed], node) =>
        node.kind === "dir" ? [added + node.additions, removed + node.deletions]
          : [added + node.file.additions, removed + node.file.deletions], [0, 0]);
      const [additions, deletions] = totals(children);
      return { kind: "dir", key: `${prefix}\0dir\0${path}`, name: label, path, additions, deletions, children };
    }),
    ...[...folder.files].sort((left, right) => compare(left.path, right.path)).map((file): FileTreeNode<F> => ({
      kind: "file", key: keyOf(file), name: file.path.slice(file.path.lastIndexOf("/") + 1), file,
    })),
  ];
  return convert(root, "");
}

/** Files in the order the tree shows them. */
export function treeFiles<F extends TreeFile>(nodes: readonly FileTreeNode<F>[]): F[] {
  return nodes.flatMap((node) => node.kind === "dir" ? treeFiles(node.children) : [node.file]);
}
