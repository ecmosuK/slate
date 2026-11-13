"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/react/style.css";

import type { PartialBlock } from "@blocknote/core";
import { BlockNoteViewRaw as BlockNoteView, useCreateBlockNote } from "@blocknote/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addNotePage,
  createNotePage,
  findNotePage,
  indentNotePage,
  noteDescendants,
  noteTree,
  outdentNotePage,
  parseNotePages,
  removeNotePage,
  renameNotePage,
  serializeNotePages,
  setNoteCollapsed,
  setNotePageContent,
  type NotePage,
  type NoteTreeNode,
} from "@slate/shared/notes";

type Blocks = PartialBlock[];
type Page = NotePage<Blocks>;

const STORAGE_KEY = "slate:notes:pages";

function emptyBlocks(): Blocks {
  return [{ type: "paragraph", content: [] }];
}

function seedPages(): Page[] {
  return [
    createNotePage<Blocks>({
      id: "welcome",
      title: "Welcome",
      content: [
        {
          type: "paragraph",
          content: "Start writing. This is a BlockNote skeleton with a page tree.",
        },
      ],
    }),
  ];
}

/** Whether stored content still looks like a block document. */
function isBlocks(value: unknown): value is Blocks {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { type?: unknown }).type === "string",
    )
  );
}

function loadPages(): Page[] {
  if (typeof window === "undefined") return seedPages();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedPages();
    const parsed = parseNotePages<Blocks>(JSON.parse(raw), isBlocks);
    return parsed.length > 0 ? parsed : seedPages();
  } catch {
    return seedPages();
  }
}

export default function NotesClient() {
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const loaded = loadPages();
    setPages(loaded);
    setSelectedId(loaded[0]?.id ?? null);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeNotePages(pages));
    } catch {
      // The browser may refuse to store, for instance in private mode. The page still works.
    }
  }, [pages, ready]);

  const selected = useMemo(
    () => (selectedId === null ? null : findNotePage(pages, selectedId)),
    [pages, selectedId],
  );

  const tree = useMemo(() => noteTree(pages), [pages]);

  const addPage = useCallback((parentId: string | null) => {
    const page = createNotePage<Blocks>({ parentId, content: emptyBlocks() });
    setPages((prev) => addNotePage(prev, page));
    setSelectedId(page.id);
  }, []);

  const deletePage = useCallback(
    (id: string) => {
      const doomed = new Set([id, ...noteDescendants(pages, id).map((page) => page.id)]);
      const target = findNotePage(pages, id);
      setPages((prev) => removeNotePage(prev, id));
      setSelectedId((current) => {
        if (current === null || !doomed.has(current)) return current;
        return target?.parentId ?? null;
      });
    },
    [pages],
  );

  const rename = useCallback((id: string, title: string) => {
    setPages((prev) => renameNotePage(prev, id, title));
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setPages((prev) => {
      const page = findNotePage(prev, id);
      if (page === null) return prev;
      return setNoteCollapsed(prev, id, !page.collapsed);
    });
  }, []);

  const setContent = useCallback((id: string, content: Blocks) => {
    setPages((prev) => {
      const page = findNotePage(prev, id);
      if (page === null) return prev;
      if (JSON.stringify(page.content) === JSON.stringify(content)) return prev;
      return setNotePageContent(prev, id, content);
    });
  }, []);

  const indent = useCallback((id: string) => {
    setPages((prev) => indentNotePage(prev, id));
  }, []);

  const outdent = useCallback((id: string) => {
    setPages((prev) => outdentNotePage(prev, id));
  }, []);

  if (!ready) {
    return <div className="empty">Loading notes…</div>;
  }

  return (
    <div className="notes-shell">
      <aside className="notes-tree">
        <div className="notes-tree-head">
          <span>Pages</span>
          <button
            type="button"
            className="notes-add"
            onClick={() => addPage(null)}
            title="New page"
            aria-label="New page"
          >
            +
          </button>
        </div>
        <ul className="notes-tree-list">
          {tree.map((node) => (
            <PageTreeItem
              key={node.page.id}
              node={node}
              pages={pages}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAddChild={addPage}
              onRemove={deletePage}
              onToggle={toggleCollapse}
              onIndent={indent}
              onOutdent={outdent}
            />
          ))}
        </ul>
        {pages.length === 0 && <p className="sidebar-empty">No pages yet.</p>}
      </aside>
      <section className="notes-editor">
        {selected ? (
          <>
            <input
              className="notes-title"
              value={selected.title}
              onChange={(event) => rename(selected.id, event.target.value)}
              placeholder="Untitled"
              aria-label="Page title"
            />
            <PageEditor
              key={selected.id}
              page={selected}
              onChange={(content) => setContent(selected.id, content)}
            />
          </>
        ) : (
          <div className="empty">Select or create a page.</div>
        )}
      </section>
    </div>
  );
}

function PageTreeItem({
  node,
  pages,
  selectedId,
  onSelect,
  onAddChild,
  onRemove,
  onToggle,
  onIndent,
  onOutdent,
}: {
  node: NoteTreeNode<Blocks>;
  pages: Page[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string | null) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
}) {
  const { page, children } = node;
  const siblings = pages.filter((entry) => entry.parentId === page.parentId);
  const position = siblings.findIndex((entry) => entry.id === page.id);

  return (
    <li className="notes-tree-node">
      <div className={selectedId === page.id ? "notes-tree-row active" : "notes-tree-row"}>
        {children.length > 0 ? (
          <button
            type="button"
            className="notes-chevron"
            onClick={() => onToggle(page.id)}
            aria-label={page.collapsed ? "Expand" : "Collapse"}
          >
            {page.collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="notes-chevron placeholder" />
        )}
        <button
          type="button"
          className="notes-tree-label"
          onClick={() => onSelect(page.id)}
        >
          {page.title || "Untitled"}
        </button>
        <button
          type="button"
          className="notes-tree-action"
          onClick={() => onIndent(page.id)}
          disabled={position <= 0}
          title="Nest under the page above"
          aria-label="Nest under the page above"
        >
          ⇥
        </button>
        <button
          type="button"
          className="notes-tree-action"
          onClick={() => onOutdent(page.id)}
          disabled={page.parentId === null}
          title="Move out one level"
          aria-label="Move out one level"
        >
          ⇤
        </button>
        <button
          type="button"
          className="notes-tree-action"
          onClick={() => onAddChild(page.id)}
          title="Add child page"
          aria-label="Add child page"
        >
          +
        </button>
        <button
          type="button"
          className="notes-tree-action"
          onClick={() => onRemove(page.id)}
          title="Delete page"
          aria-label="Delete page"
        >
          ×
        </button>
      </div>
      {!page.collapsed && children.length > 0 && (
        <ul className="notes-tree-children">
          {children.map((child) => (
            <PageTreeItem
              key={child.page.id}
              node={child}
              pages={pages}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onRemove={onRemove}
              onToggle={onToggle}
              onIndent={onIndent}
              onOutdent={onOutdent}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function PageEditor({
  page,
  onChange,
}: {
  page: Page;
  onChange: (content: Blocks) => void;
}) {
  const editor = useCreateBlockNote({ initialContent: page.content });
  return <BlockNoteView editor={editor} onChange={() => onChange(editor.document)} />;
}