import type { CollectionEntry } from "astro:content";
import type { Locale } from "@/i18n/config";
import { getPostDirectorySegments, type PostDirectorySegment } from "./getPath";
import getSortedPosts from "./getSortedPosts";
import { getPostBaseId } from "./postI18n";

type BlogPost = CollectionEntry<"blog">;

export type PostTreeConfig = Readonly<{
  maxSubdirectoriesPerDirectory: number;
  maxPostsPerDirectory: number;
  directoryIntroFileName: string;
}>;

export type PostTreeNode = {
  name: string;
  slug: string;
  depth: number;
  posts: BlogPost[];
  children: PostTreeNode[];
  introPost?: BlogPost;
};

export type PostTreeRoot = {
  posts: BlogPost[];
  children: PostTreeNode[];
  introPost?: BlogPost;
};

type MutablePostTreeRoot = Omit<PostTreeRoot, "children"> & {
  children: MutablePostTreeNode[];
  childrenBySlug: Map<string, MutablePostTreeNode>;
};

type MutablePostTreeNode = Omit<PostTreeNode, "children"> & {
  children: MutablePostTreeNode[];
  childrenBySlug: Map<string, MutablePostTreeNode>;
};

function createRootNode(): MutablePostTreeRoot {
  return {
    posts: [],
    children: [],
    childrenBySlug: new Map(),
  };
}

function createTreeNode(
  segment: PostDirectorySegment,
  depth: number
): MutablePostTreeNode {
  return {
    name: segment.name,
    slug: segment.slug,
    depth,
    posts: [],
    children: [],
    childrenBySlug: new Map(),
  };
}

function getOrCreateNode(
  root: MutablePostTreeRoot,
  segments: PostDirectorySegment[]
) {
  let current: MutablePostTreeRoot | MutablePostTreeNode = root;

  for (const [depth, segment] of segments.entries()) {
    const existingNode: MutablePostTreeNode | undefined =
      current.childrenBySlug.get(segment.slug);

    if (existingNode) {
      current = existingNode;
      continue;
    }

    const node = createTreeNode(segment, depth);
    current.childrenBySlug.set(segment.slug, node);
    current.children.push(node);
    current = node;
  }

  return current;
}

function getPostBaseFileName(post: BlogPost) {
  return getPostBaseId(post).split("/").pop() ?? "";
}

function isDirectoryIntroPost(post: BlogPost, config: PostTreeConfig) {
  return (
    getPostBaseFileName(post).toLowerCase() ===
    config.directoryIntroFileName.toLowerCase()
  );
}

function sortChildren(
  node: MutablePostTreeRoot | MutablePostTreeNode,
  collator: Intl.Collator
) {
  node.children.sort((a, b) => collator.compare(a.name, b.name));

  for (const child of node.children) {
    sortChildren(child, collator);
  }
}

function toReadonlyNode(node: MutablePostTreeNode): PostTreeNode {
  return {
    name: node.name,
    slug: node.slug,
    depth: node.depth,
    posts: node.posts,
    introPost: node.introPost,
    children: node.children.map(toReadonlyNode),
  };
}

function toReadonlyRoot(root: MutablePostTreeRoot): PostTreeRoot {
  return {
    posts: root.posts,
    introPost: root.introPost,
    children: root.children.map(toReadonlyNode),
  };
}

export function buildPostTree(
  posts: BlogPost[],
  locale: Locale,
  config: PostTreeConfig
): PostTreeRoot {
  const root = createRootNode();
  const sortedPosts = getSortedPosts(posts, locale);
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });

  for (const post of sortedPosts) {
    const directorySegments = getPostDirectorySegments(post.id, post.filePath);
    const targetNode = getOrCreateNode(root, directorySegments);

    if (isDirectoryIntroPost(post, config)) {
      if (!targetNode.introPost) {
        targetNode.introPost = post;
        continue;
      }
    }

    targetNode.posts.push(post);
  }

  sortChildren(root, collator);

  return toReadonlyRoot(root);
}
