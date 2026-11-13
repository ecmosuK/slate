import { describe, expect, it } from "vitest";

import {
  addNotePage,
  childNotePages,
  createNotePage,
  indentNotePage,
  isNoteDescendant,
  moveNotePage,
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
} from "@slate/shared";

type Page = NotePage<string>;

function page(id: string, parentId: string | null = null, title = id): Page {
  return { id, title, parentId, content: `body of ${id}`, collapsed: false };
}

/** root, with two children, and a grandchild under the first child. */
function tree(): Page[] {
  return [
    page("root"),
    page("a", "root"),
    page("b", "root"),
    page("a1", "a"),
  ];
}

function ids(pages: readonly Page[]): string[] {
  return pages.map((entry) => entry.id);
}

describe("noteTree", () => {
  it("nests pages under their parent and keeps sibling order", () => {
    const nodes = noteTree(tree());

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.page.id).toBe("root");
    expect(nodes[0]?.children.map((node) => node.page.id)).toEqual(["a", "b"]);
    expect(nodes[0]?.children[0]?.children.map((node) => node.page.id)).toEqual(["a1"]);
  });

  it("puts a page whose parent has gone at the root", () => {
    const nodes = noteTree([page("orphan", "missing")]);

    expect(nodes.map((node) => node.page.id)).toEqual(["orphan"]);
    expect(nodes[0]?.children).toEqual([]);
  });

  it("does not let a page be its own parent", () => {
    const nodes = noteTree([page("loop", "loop")]);

    expect(nodes.map((node) => node.page.id)).toEqual(["loop"]);
  });

  it("keeps pages caught in a parent cycle visible", () => {
    const nodes = noteTree([page("x", "y"), page("y", "x")]);

    expect(nodes.map((node) => node.page.id)).toEqual(["x"]);
    expect(nodes[0]?.children.map((node) => node.page.id)).toEqual(["y"]);
  });
});

describe("noteDescendants", () => {
  it("lists every page below one page", () => {
    expect(ids(noteDescendants(tree(), "root"))).toEqual(["a", "a1", "b"]);
    expect(ids(noteDescendants(tree(), "a"))).toEqual(["a1"]);
    expect(noteDescendants(tree(), "a1")).toEqual([]);
  });

  it("answers whether a page sits below another", () => {
    expect(isNoteDescendant(tree(), "root", "a1")).toBe(true);
    expect(isNoteDescendant(tree(), "a1", "root")).toBe(false);
    expect(isNoteDescendant(tree(), "root", "root")).toBe(false);
  });
});

describe("addNotePage", () => {
  it("adds a page under an existing parent", () => {
    const next = addNotePage(tree(), page("a2", "a"));

    expect(ids(next)).toEqual(["root", "a", "b", "a1", "a2"]);
    expect(childNotePages(next, "a").map((entry) => entry.id)).toEqual(["a1", "a2"]);
  });

  it("puts a page at the root when the parent is unknown", () => {
    const next = addNotePage(tree(), page("stray", "nowhere"));

    expect(childNotePages(next, null).map((entry) => entry.id)).toEqual(["root", "stray"]);
  });
});

describe("removeNotePage", () => {
  it("removes the page and everything below it", () => {
    expect(ids(removeNotePage(tree(), "a"))).toEqual(["root", "b"]);
  });

  it("leaves the other pages alone", () => {
    expect(ids(removeNotePage(tree(), "b"))).toEqual(["root", "a", "a1"]);
  });

  it("ignores a page that is not there", () => {
    expect(ids(removeNotePage(tree(), "nope"))).toEqual(["root", "a", "b", "a1"]);
  });
});

describe("renameNotePage", () => {
  it("changes only the title", () => {
    const next = renameNotePage(tree(), "a", "Alpha");

    expect(next.find((entry) => entry.id === "a")?.title).toBe("Alpha");
    expect(next.find((entry) => entry.id === "b")?.title).toBe("b");
  });
});

describe("setNotePageContent", () => {
  it("changes only the content", () => {
    const next = setNotePageContent(tree(), "a", "new body");

    expect(next.find((entry) => entry.id === "a")?.content).toBe("new body");
    expect(next.find((entry) => entry.id === "b")?.content).toBe("body of b");
  });
});

describe("setNoteCollapsed", () => {
  it("flags the page", () => {
    const next = setNoteCollapsed(tree(), "a", true);

    expect(next.find((entry) => entry.id === "a")?.collapsed).toBe(true);
    expect(next.find((entry) => entry.id === "b")?.collapsed).toBe(false);
  });
});

describe("moveNotePage", () => {
  it("moves a page under another parent", () => {
    const next = moveNotePage(tree(), "b", "a");

    expect(next.find((entry) => entry.id === "b")?.parentId).toBe("a");
    expect(ids(childNotePages(next, "a"))).toEqual(["a1", "b"]);
  });

  it("moves a page back to the root", () => {
    const next = moveNotePage(tree(), "a1", null);

    expect(next.find((entry) => entry.id === "a1")?.parentId).toBe(null);
    expect(ids(childNotePages(next, null))).toEqual(["root", "a1"]);
  });

  it("puts a page at a chosen position among its new siblings", () => {
    const next = moveNotePage(tree(), "b", "root", 0);

    expect(ids(childNotePages(next, "root"))).toEqual(["b", "a"]);
  });

  it("puts a page at a chosen position among the children of a parent", () => {
    const next = moveNotePage(tree(), "b", "a", 0);

    expect(ids(childNotePages(next, "a"))).toEqual(["b", "a1"]);
  });

  it("keeps the pages below a moved page with it", () => {
    const next = moveNotePage(tree(), "a", "b");

    expect(next.find((entry) => entry.id === "a")?.parentId).toBe("b");
    expect(next.find((entry) => entry.id === "a1")?.parentId).toBe("a");
  });

  it("refuses to move a page under itself", () => {
    expect(ids(moveNotePage(tree(), "a", "a"))).toEqual(["root", "a", "b", "a1"]);
  });

  it("refuses to move a page under its own child", () => {
    expect(ids(moveNotePage(tree(), "a", "a1"))).toEqual(["root", "a", "b", "a1"]);
  });

  it("refuses to move a page under a parent that is not there", () => {
    expect(ids(moveNotePage(tree(), "a", "nowhere"))).toEqual(["root", "a", "b", "a1"]);
  });
});

describe("indentNotePage", () => {
  it("moves a page under the sibling above it", () => {
    const next = indentNotePage(tree(), "b");

    expect(next.find((entry) => entry.id === "b")?.parentId).toBe("a");
    expect(ids(childNotePages(next, "a"))).toEqual(["a1", "b"]);
  });

  it("leaves a first sibling where it is", () => {
    expect(ids(indentNotePage(tree(), "a"))).toEqual(["root", "a", "b", "a1"]);
  });

  it("leaves a page at the root where it is", () => {
    expect(ids(indentNotePage(tree(), "root"))).toEqual(["root", "a", "b", "a1"]);
  });
});

describe("outdentNotePage", () => {
  it("moves a page out to sit after its parent", () => {
    const next = outdentNotePage(tree(), "a1");

    expect(next.find((entry) => entry.id === "a1")?.parentId).toBe("root");
    expect(ids(childNotePages(next, "root"))).toEqual(["a", "a1", "b"]);
  });

  it("moves a page out to the top level", () => {
    const next = outdentNotePage(tree(), "a");

    expect(next.find((entry) => entry.id === "a")?.parentId).toBe(null);
    expect(ids(childNotePages(next, null))).toEqual(["root", "a"]);
  });

  it("leaves a page at the root where it is", () => {
    expect(ids(outdentNotePage(tree(), "root"))).toEqual(["root", "a", "b", "a1"]);
  });
});

describe("serializeNotePages and parseNotePages", () => {
  it("round-trips the pages", () => {
    const pages = tree();
    const parsed = parseNotePages<string>(JSON.parse(serializeNotePages(pages)));

    expect(parsed).toEqual(pages);
  });

  it("reads a bare array as well as the envelope", () => {
    const parsed = parseNotePages<string>([page("a")]);

    expect(ids(parsed)).toEqual(["a"]);
  });

  it("drops entries that are not pages", () => {
    const parsed = parseNotePages<string>([
      page("a"),
      null,
      "nope",
      { id: "b" },
      { ...page("c"), id: "" },
    ]);

    expect(ids(parsed)).toEqual(["a"]);
  });

  it("keeps the first of two pages with the same id", () => {
    const parsed = parseNotePages<string>([page("a", null, "first"), page("a", null, "second")]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe("first");
  });

  it("fills in the defaults for a page with missing fields", () => {
    const parsed = parseNotePages<string>([{ id: "a", content: "body" }]);

    expect(parsed[0]?.title).toBe("Untitled");
    expect(parsed[0]?.parentId).toBe(null);
    expect(parsed[0]?.collapsed).toBe(false);
  });

  it("uses the content guard to reject a bad block document", () => {
    const kept = parseNotePages<string>(
      [page("a")],
      (content): content is string => typeof content === "string",
    );

    expect(ids(kept)).toEqual(["a"]);

    const rejected = parseNotePages<unknown>(
      [page("a")],
      (content): content is unknown => typeof content === "number",
    );

    expect(rejected).toEqual([]);
  });

  it("returns nothing for a value that is not a list of pages", () => {
    expect(parseNotePages(null)).toEqual([]);
    expect(parseNotePages("nope")).toEqual([]);
    expect(parseNotePages({ version: 1 })).toEqual([]);
  });
});

describe("createNotePage", () => {
  it("makes an untitled page at the root", () => {
    const created = createNotePage({ content: "body" });

    expect(created.title).toBe("Untitled");
    expect(created.parentId).toBe(null);
    expect(created.collapsed).toBe(false);
    expect(created.content).toBe("body");
    expect(created.id).not.toBe("");
  });

  it("takes an explicit id", () => {
    expect(createNotePage({ id: "fixed", content: "" }).id).toBe("fixed");
  });
});
