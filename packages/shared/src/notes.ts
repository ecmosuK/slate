/**
 * The page tree behind the editor.
 *
 * Slate's editor is a tree of pages, and each page holds a block document. The tree is plain
 * data so it can be reasoned about, tested and stored without a browser. BlockNote's own types
 * deliberately stay out of this file: the shared package also runs in the CLI and in Node tests,
 * so the content of a page is carried generically and the editor supplies its own type at the
 * edge.
 *
 * The rules the tree keeps:
 *
 * - A page has one parent. The root pages have `parentId: null`.
 * - Removing a page removes its whole subtree.
 * - A page can never become its own ancestor.
 * - Pages whose parent has gone missing surface at the root instead of disappearing.
 */

export interface NotePage<C = unknown> {
  id: string;
  title: string;
  /** `null` for a page at the root of the tree. */
  parentId: string | null;
  content: C;
  /** Whether the page's children are hidden in the tree. */
  collapsed: boolean;
}

export interface NoteTreeNode<C = unknown> {
  page: NotePage<C>;
  children: NoteTreeNode<C>[];
}

export const DEFAULT_NOTE_TITLE = "Untitled";

/** The version written into the stored envelope, so old notes can be migrated later. */
export const NOTES_FORMAT_VERSION = 1;

export function newPageId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `p-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function createNotePage<C>(init: {
  id?: string;
  title?: string;
  parentId?: string | null;
  content: C;
  collapsed?: boolean;
}): NotePage<C> {
  return {
    id: init.id ?? newPageId(),
    title: init.title ?? DEFAULT_NOTE_TITLE,
    parentId: init.parentId ?? null,
    content: init.content,
    collapsed: init.collapsed ?? false,
  };
}

export function findNotePage<C>(pages: readonly NotePage<C>[], id: string): NotePage<C> | null {
  return pages.find((page) => page.id === id) ?? null;
}

/** The direct children of one parent, in tree order. */
export function childNotePages<C>(
  pages: readonly NotePage<C>[],
  parentId: string | null,
): NotePage<C>[] {
  return pages.filter((page) => page.parentId === parentId);
}

/**
 * Build the tree from the flat list of pages.
 *
 * Pages keep their order in the list, and that order is the order of their siblings.
 */
export function noteTree<C>(pages: readonly NotePage<C>[]): NoteTreeNode<C>[] {
  const known = new Set(pages.map((page) => page.id));
  const children = new Map<string, NotePage<C>[]>();
  const roots: NotePage<C>[] = [];

  for (const page of pages) {
    if (page.parentId !== null && page.parentId !== page.id && known.has(page.parentId)) {
      const list = children.get(page.parentId);
      if (list) list.push(page);
      else children.set(page.parentId, [page]);
    } else {
      roots.push(page);
    }
  }

  const build = (parentId: string, path: Set<string>): NoteTreeNode<C>[] =>
    (children.get(parentId) ?? [])
      .filter((page) => !path.has(page.id))
      .map((page) => {
        const next = new Set(path);
        next.add(page.id);
        return { page, children: build(page.id, next) };
      });

  const tree = roots.map((page) => ({ page, children: build(page.id, new Set([page.id])) }));

  // Pages caught in a parent cycle are unreachable from any root. Hang them off the end so they
  // stay visible rather than silently disappearing.
  const seen = new Set<string>();
  const mark = (nodes: readonly NoteTreeNode<C>[]) => {
    for (const node of nodes) {
      seen.add(node.page.id);
      mark(node.children);
    }
  };
  mark(tree);

  for (const page of pages) {
    if (seen.has(page.id)) continue;
    const node = { page, children: build(page.id, new Set([page.id])) };
    tree.push(node);
    mark([node]);
  }

  return tree;
}

/** Every page below `id`, depth first. */
export function noteDescendants<C>(pages: readonly NotePage<C>[], id: string): NotePage<C>[] {
  const out: NotePage<C>[] = [];
  const seen = new Set<string>([id]);

  const walk = (parentId: string) => {
    for (const page of pages) {
      if (page.parentId !== parentId || seen.has(page.id)) continue;
      seen.add(page.id);
      out.push(page);
      walk(page.id);
    }
  };

  walk(id);
  return out;
}

/** Whether `candidateId` sits somewhere below `ancestorId`. */
export function isNoteDescendant<C>(
  pages: readonly NotePage<C>[],
  ancestorId: string,
  candidateId: string,
): boolean {
  if (ancestorId === candidateId) return false;
  return noteDescendants(pages, ancestorId).some((page) => page.id === candidateId);
}

/** Add one page. The parent must already exist, otherwise the page lands at the root. */
export function addNotePage<C>(pages: readonly NotePage<C>[], page: NotePage<C>): NotePage<C>[] {
  const parentId =
    page.parentId !== null && findNotePage(pages, page.parentId) === null ? null : page.parentId;
  return [...pages, { ...page, parentId }];
}

/** Remove a page and everything below it. */
export function removeNotePage<C>(pages: readonly NotePage<C>[], id: string): NotePage<C>[] {
  const doomed = new Set<string>([id, ...noteDescendants(pages, id).map((page) => page.id)]);
  return pages.filter((page) => !doomed.has(page.id));
}

export function renameNotePage<C>(
  pages: readonly NotePage<C>[],
  id: string,
  title: string,
): NotePage<C>[] {
  return pages.map((page) => (page.id === id ? { ...page, title } : page));
}

export function setNotePageContent<C>(
  pages: readonly NotePage<C>[],
  id: string,
  content: C,
): NotePage<C>[] {
  return pages.map((page) => (page.id === id ? { ...page, content } : page));
}

export function setNoteCollapsed<C>(
  pages: readonly NotePage<C>[],
  id: string,
  collapsed: boolean,
): NotePage<C>[] {
  return pages.map((page) => (page.id === id ? { ...page, collapsed } : page));
}

function findNoteNode<C>(
  nodes: readonly NoteTreeNode<C>[],
  id: string,
): NoteTreeNode<C> | null {
  for (const node of nodes) {
    if (node.page.id === id) return node;
    const found = findNoteNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function detachNoteNode<C>(
  nodes: NoteTreeNode<C>[],
  id: string,
): NoteTreeNode<C> | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.page.id === id) {
      const [removed] = nodes.splice(index, 1);
      return removed ?? null;
    }
    const found = detachNoteNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function flattenNoteTree<C>(
  nodes: readonly NoteTreeNode<C>[],
  parentId: string | null = null,
): NotePage<C>[] {
  const out: NotePage<C>[] = [];
  for (const node of nodes) {
    out.push({ ...node.page, parentId });
    out.push(...flattenNoteTree(node.children, node.page.id));
  }
  return out;
}

/**
 * Move a page under a new parent, at a given position among its new siblings.
 *
 * Without an `index` the page goes last among its new siblings. The move is refused when it
 * would make the page its own ancestor, when the target parent does not exist, or when the page
 * is not there at all.
 */
export function moveNotePage<C>(
  pages: readonly NotePage<C>[],
  id: string,
  parentId: string | null,
  index?: number,
): NotePage<C>[] {
  if (findNotePage(pages, id) === null) return [...pages];
  if (parentId !== null) {
    if (parentId === id) return [...pages];
    if (findNotePage(pages, parentId) === null) return [...pages];
    if (isNoteDescendant(pages, id, parentId)) return [...pages];
  }

  const tree = noteTree(pages);
  const moved = detachNoteNode(tree, id);
  if (moved === null) return [...pages];

  const siblings = parentId === null ? tree : (findNoteNode(tree, parentId)?.children ?? []);
  const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, moved);

  return flattenNoteTree(tree);
}

/** The pages that sit beside one page, in tree order. */
function siblingPages<C>(pages: readonly NotePage<C>[], id: string): NotePage<C>[] | null {
  const page = findNotePage(pages, id);
  if (page === null) return null;

  const tree = noteTree(pages);
  const siblings =
    page.parentId === null ? tree : (findNoteNode(tree, page.parentId)?.children ?? []);
  return siblings.map((node) => node.page);
}

/**
 * Move a page one level deeper, under the sibling above it.
 *
 * A page that is already first among its siblings has nothing to move under, so it stays put.
 */
export function indentNotePage<C>(pages: readonly NotePage<C>[], id: string): NotePage<C>[] {
  const siblings = siblingPages(pages, id);
  if (siblings === null) return [...pages];

  const index = siblings.findIndex((page) => page.id === id);
  if (index <= 0) return [...pages];

  const previous = siblings[index - 1];
  if (previous === undefined) return [...pages];

  return moveNotePage(pages, id, previous.id);
}

/**
 * Move a page one level out, so it becomes a sibling of its own parent.
 *
 * The page lands directly after that parent, so the order of the tree is kept.
 */
export function outdentNotePage<C>(pages: readonly NotePage<C>[], id: string): NotePage<C>[] {
  const page = findNotePage(pages, id);
  if (page === null || page.parentId === null) return [...pages];

  const parent = findNotePage(pages, page.parentId);
  if (parent === null) return [...pages];

  const siblings = siblingPages(pages, parent.id) ?? [];
  const index = siblings.findIndex((entry) => entry.id === parent.id);

  return moveNotePage(pages, id, parent.parentId, index + 1);
}

/** Write the pages into the stored envelope. */export function serializeNotePages<C>(pages: readonly NotePage<C>[]): string {
  return JSON.stringify({ version: NOTES_FORMAT_VERSION, pages });
}

/**
 * Read pages back from storage.
 *
 * Anything that does not look like a page is dropped, so a half-written or hand-edited file
 * costs a few pages rather than the whole tree. `isContent` decides what counts as a valid
 * block document; the default accepts anything.
 */
export function parseNotePages<C = unknown>(
  value: unknown,
  isContent: (content: unknown) => content is C = (content: unknown): content is C => true,
): NotePage<C>[] {
  const envelope = value as { pages?: unknown } | null;
  const list = Array.isArray(value)
    ? value
    : typeof envelope === "object" && envelope !== null && Array.isArray(envelope.pages)
      ? envelope.pages
      : null;
  if (list === null) return [];

  const out: NotePage<C>[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;

    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
    if (id === null || seen.has(id)) continue;
    if (raw.content === undefined) continue;
    if (!isContent(raw.content)) continue;

    const parentId = typeof raw.parentId === "string" && raw.parentId !== "" ? raw.parentId : null;
    seen.add(id);

    out.push({
      id,
      title: typeof raw.title === "string" ? raw.title : DEFAULT_NOTE_TITLE,
      parentId: parentId === id ? null : parentId,
      content: raw.content,
      collapsed: raw.collapsed === true,
    });
  }

  return out;
}
