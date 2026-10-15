import path from "node:path";
import { fileURLToPath } from "node:url";

const tagRoot = fileURLToPath(new URL("../data/tags/", import.meta.url));

/** Keep the page title as the only h1 while preserving Markdown heading hierarchy. */
export default function remarkTagHeadings() {
  return (tree, file) => {
    if (!file.path) return;
    const relative = path.relative(tagRoot, file.path);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return;
    const nodes = [tree];
    const headings = [];
    for (const node of nodes) {
      if (node.type === "heading") headings.push(node);
      if (node.children) nodes.push(...node.children);
    }
    if (headings.some(heading => heading.depth === 1))
      for (const heading of headings)
        heading.depth = Math.min(6, heading.depth + 1);
  };
}
