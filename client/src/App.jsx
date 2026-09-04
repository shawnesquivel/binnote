import { marked } from "marked";
import TurndownService from "turndown";
import { Image } from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.addRule("images", {
  filter: "img",
  replacement(_content, node) {
    const alt = node.getAttribute("alt") || "";
    const src = node.getAttribute("src") || "";
    const relative = node.getAttribute("data-relative");
    return `![${alt}](${relative || src})`;
  },
});

function markdownToHtml(markdown) {
  const html = String(marked.parse(markdown || "", { async: false }));
  return html
    .replace(
      /src="(media\/[^"]+)"/g,
      (_m, rel) => `src="/${rel}" data-relative="${rel}"`
    )
    .replace(/src="(\/media\/[^"]+)"/g, (_m, src) => {
      const rel = src.slice(1);
      return `src="${src}" data-relative="${rel}"`;
    });
}

function htmlToMarkdown(html) {
  return turndown.turndown(html || "").trim() + "\n";
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

const LocalImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-relative": {
        default: null,
        parseHTML: (element) => element.getAttribute("data-relative"),
        renderHTML: (attributes) => {
          if (!attributes["data-relative"]) return {};
          return { "data-relative": attributes["data-relative"] };
        },
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: { class: "note-image" },
});

export default function App() {
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("Loading…");
  const [mediaPath, setMediaPath] = useState("");
  const [bootError, setBootError] = useState("");

  const saveTimer = useRef(null);
  const activeIdRef = useRef(null);
  const uploading = useRef(false);
  const loadGen = useRef(0);
  const pendingMarkdown = useRef(null);
  const editorRef = useRef(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const refreshNotes = useCallback(async () => {
    const data = await api("/api/notes");
    setNotes(data.notes);
    setMediaPath(data.media);
    return data.notes;
  }, []);

  const saveNote = useCallback(async (id, markdown) => {
    setStatus("Saving…");
    const meta = await api(`/api/notes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: markdown }),
    });
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === id ? { id, title: meta.title, updatedAt: meta.updatedAt } : n
      );
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      return next;
    });
    setStatus("Saved");
  }, []);

  const scheduleSave = useCallback(
    (ed) => {
      const id = activeIdRef.current;
      if (!id || !ed) return;
      clearTimeout(saveTimer.current);
      setStatus("Editing…");
      saveTimer.current = setTimeout(() => {
        const md = htmlToMarkdown(ed.getHTML());
        saveNote(id, md).catch((err) => setStatus(err.message));
      }, 500);
    },
    [saveNote]
  );

  const uploadImage = useCallback(async (file) => {
    const id = activeIdRef.current;
    if (!id || !file) return null;
    const form = new FormData();
    form.append("image", file, file.name || "paste.png");
    return api(`/api/notes/${id}/images`, { method: "POST", body: form });
  }, []);

  const applyMarkdown = useCallback((markdown) => {
    const ed = editorRef.current;
    if (!ed) {
      pendingMarkdown.current = markdown;
      return;
    }
    pendingMarkdown.current = null;
    ed.commands.setContent(markdownToHtml(markdown), false);
  }, []);

  const loadNote = useCallback(
    async (id) => {
      clearTimeout(saveTimer.current);
      const gen = ++loadGen.current;
      setActiveId(id);
      setStatus("Loading…");
      const note = await api(`/api/notes/${id}`);
      if (gen !== loadGen.current) return;
      applyMarkdown(note.content);
      setStatus("Ready");
      return note;
    },
    [applyMarkdown]
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      LocalImage,
      Placeholder.configure({
        placeholder: "Start typing… paste an image anytime",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "prose-surface",
        spellcheck: "true",
      },
      handlePaste(view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const imageItems = [...items].filter((i) => i.type.startsWith("image/"));
        if (!imageItems.length) return false;

        event.preventDefault();
        (async () => {
          if (uploading.current) return;
          uploading.current = true;
          setStatus("Saving image…");
          try {
            for (const item of imageItems) {
              const file = item.getAsFile();
              if (!file) continue;
              const result = await uploadImage(file);
              if (!result) continue;
              const node = view.state.schema.nodes.image.create({
                src: result.url,
                alt: "",
                "data-relative": result.relative,
              });
              view.dispatch(
                view.state.tr.replaceSelectionWith(node).scrollIntoView()
              );
            }
            setStatus("Image saved to media bin");
          } catch (err) {
            setStatus(err.message || "Image upload failed");
          } finally {
            uploading.current = false;
          }
        })();
        return true;
      },
      handleDrop(view, event) {
        const files = [...(event.dataTransfer?.files || [])].filter((f) =>
          f.type.startsWith("image/")
        );
        if (!files.length) return false;
        event.preventDefault();
        (async () => {
          if (uploading.current) return;
          uploading.current = true;
          setStatus("Saving image…");
          try {
            const coords = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            let pos = coords?.pos ?? view.state.selection.from;
            for (const file of files) {
              const result = await uploadImage(file);
              if (!result) continue;
              const node = view.state.schema.nodes.image.create({
                src: result.url,
                alt: file.name,
                "data-relative": result.relative,
              });
              view.dispatch(view.state.tr.insert(pos, node));
              pos += node.nodeSize;
            }
            setStatus("Image saved to media bin");
          } catch (err) {
            setStatus(err.message || "Image upload failed");
          } finally {
            uploading.current = false;
          }
        })();
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => scheduleSave(ed),
  });

  useEffect(() => {
    editorRef.current = editor;
    if (!editor || pendingMarkdown.current == null) return;
    const md = pendingMarkdown.current;
    pendingMarkdown.current = null;
    editor.commands.setContent(markdownToHtml(md), false);
  }, [editor]);

  useEffect(() => {
    (async () => {
      try {
        const list = await refreshNotes();
        if (!list.length) {
          const created = await api("/api/notes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Untitled" }),
          });
          await refreshNotes();
          await loadNote(created.id);
        } else {
          await loadNote(list[0].id);
        }
      } catch (err) {
        setBootError(
          err.message ||
            "Could not reach the Binnote server. Run npm start from the project root."
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createNote() {
    try {
      setStatus("Creating…");
      const created = await api("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled" }),
      });
      await refreshNotes();
      await loadNote(created.id);
      requestAnimationFrame(() => editorRef.current?.commands.focus("end"));
    } catch (err) {
      setStatus(err.message || "Could not create note");
    }
  }

  async function deleteNote(id) {
    if (!confirm("Delete this note and its media folder?")) return;
    await api(`/api/notes/${id}`, { method: "DELETE" });
    const list = await refreshNotes();
    if (activeId === id) {
      if (list[0]) await loadNote(list[0].id);
      else {
        setActiveId(null);
        editorRef.current?.commands.clearContent();
      }
    }
  }

  async function revealMedia() {
    setStatus("Opening media folder…");
    try {
      await api("/api/reveal-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId: activeId }),
      });
      setStatus("Media folder opened");
    } catch (err) {
      setStatus(err.message);
    }
  }

  if (bootError) {
    return (
      <div className="boot-error">
        <p className="brand">Binnote</p>
        <h1>Server offline</h1>
        <p>{bootError}</p>
        <code>npm start</code>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="brand">Binnote</p>
          <p className="tagline">Markdown in. Media on disk.</p>
        </div>

        <button type="button" className="btn primary" onClick={createNote}>
          New note
        </button>

        <ul className="note-list">
          {notes.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className={
                  note.id === activeId ? "note-item active" : "note-item"
                }
                onClick={() => loadNote(note.id)}
              >
                <span className="note-title">{note.title}</span>
                <span className="note-date">
                  {new Date(note.updatedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Delete note"
                onClick={() => deleteNote(note.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="sidebar-foot">
          <button type="button" className="btn ghost" onClick={revealMedia}>
            Open media folder
          </button>
          {mediaPath ? (
            <p className="path" title={mediaPath}>
              {mediaPath}
            </p>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <span className={`status ${status === "Saved" ? "ok" : ""}`}>
            {status}
          </span>
          <span className="hint">Paste or drop images — they save to disk</span>
        </header>
        <div className="editor-wrap">
          <EditorContent editor={editor} />
        </div>
      </main>
    </div>
  );
}
