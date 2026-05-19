import type { CollectionEntry } from "astro:content";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { getPostDirectorySegments, type PostDirectorySegment } from "./getPath";
import getSortedPosts from "./getSortedPosts";
import { getPostBaseId, getPostLocale } from "./postI18n";

type BlogPost = CollectionEntry<"blog">;
type LocaleFallbackMode = "none" | "default-locale";

export type PostTreeConfig = Readonly<{
  maxSubdirectoriesPerDirectory: number;
  maxPostsPerDirectory: number;
  directoryIntroFileName: string;
  directoryLabelFallback?: LocaleFallbackMode;
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

type DirectoryLabelIndex = Map<string, Map<Locale, string>>;

function createRootNode(): MutablePostTreeRoot {
  return {
    posts: [],
    children: [],
    childrenBySlug: new Map(),
  };
}

function createTreeNode(
  segment: PostDirectorySegment,
  name: string,
  depth: number
): MutablePostTreeNode {
  return {
    name,
    slug: segment.slug,
    depth,
    posts: [],
    children: [],
    childrenBySlug: new Map(),
  };
}

function getOrCreateNode(
  root: MutablePostTreeRoot,
  segments: PostDirectorySegment[],
  locale: Locale,
  config: PostTreeConfig,
  directoryLabelIndex: DirectoryLabelIndex
) {
  let current: MutablePostTreeRoot | MutablePostTreeNode = root;
  const currentSegments: PostDirectorySegment[] = [];

  for (const [depth, segment] of segments.entries()) {
    currentSegments.push(segment);
    const existingNode: MutablePostTreeNode | undefined =
      current.childrenBySlug.get(segment.slug);

    if (existingNode) {
      current = existingNode;
      continue;
    }

    const directoryKey = getDirectoryKey(currentSegments);
    const name = getDirectoryLabel(
      directoryKey,
      segment,
      locale,
      config,
      directoryLabelIndex
    );
    const node = createTreeNode(segment, name, depth);
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

function getDirectoryKey(segments: PostDirectorySegment[]) {
  return segments.map(segment => segment.slug).join("/");
}

function createDirectoryLabelIndex(
  posts: BlogPost[],
  config: PostTreeConfig
): DirectoryLabelIndex {
  const labelsByDirectory: DirectoryLabelIndex = new Map();

  for (const post of getSortedPosts(posts)) {
    if (!isDirectoryIntroPost(post, config)) continue;

    const directorySegments = getPostDirectorySegments(post.id, post.filePath);
    const directoryKey = getDirectoryKey(directorySegments);
    const locale = getPostLocale(post);
    const labelsByLocale =
      labelsByDirectory.get(directoryKey) ?? new Map<Locale, string>();

    if (!labelsByLocale.has(locale)) {
      labelsByLocale.set(locale, post.data.title);
    }

    labelsByDirectory.set(directoryKey, labelsByLocale);
  }

  return labelsByDirectory;
}

function getDirectoryLabel(
  directoryKey: string,
  segment: PostDirectorySegment,
  locale: Locale,
  config: PostTreeConfig,
  directoryLabelIndex: DirectoryLabelIndex
) {
  const labelsByLocale = directoryLabelIndex.get(directoryKey);
  const currentLocaleLabel = labelsByLocale?.get(locale);

  if (currentLocaleLabel) return currentLocaleLabel;

  const fallbackMode = config.directoryLabelFallback ?? "default-locale";

  if (fallbackMode === "default-locale") {
    const defaultLocaleLabel = labelsByLocale?.get(DEFAULT_LOCALE);
    if (defaultLocaleLabel) return defaultLocaleLabel;
  }

  return segment.name;
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
  const directoryLabelIndex = createDirectoryLabelIndex(posts, config);
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });

  for (const post of sortedPosts) {
    const directorySegments = getPostDirectorySegments(post.id, post.filePath);
    const targetNode = getOrCreateNode(
      root,
      directorySegments,
      locale,
      config,
      directoryLabelIndex
    );

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
