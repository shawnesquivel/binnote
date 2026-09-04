import cors from "cors";
import express from "express";
import fs from "fs/promises";
import multer from "multer";
import { nanoid } from "nanoid";
import open from "open";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.join(ROOT, "workspace");
const NOTES_DIR = path.join(WORKSPACE, "notes");
const MEDIA_DIR = path.join(WORKSPACE, "media");

const PORT = Number(process.env.PORT) || 8787;

async function ensureDirs() {
  await fs.mkdir(NOTES_DIR, { recursive: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
}

function notePath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Invalid note id");
  }
  return path.join(NOTES_DIR, `${id}.md`);
}

function mediaNoteDir(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Invalid note id");
  }
  return path.join(MEDIA_DIR, id);
}

function titleFromMarkdown(markdown, fallback = "Untitled") {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (match?.[1]?.trim()) return match[1].trim();
  const firstLine = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("!"));
  return firstLine?.replace(/^#+\s*/, "").slice(0, 80) || fallback;
}

async function readNoteMeta(id) {
  const file = notePath(id);
  const [content, stat] = await Promise.all([
    fs.readFile(file, "utf8"),
    fs.stat(file),
  ]);
  return {
    id,
    title: titleFromMarkdown(content),
    updatedAt: stat.mtimeMs,
    content,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/media", express.static(MEDIA_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    workspace: WORKSPACE,
    media: MEDIA_DIR,
  });
});

app.get("/api/notes", async (_req, res) => {
  try {
    await ensureDirs();
    const files = await fs.readdir(NOTES_DIR);
    const notes = await Promise.all(
      files
        .filter((f) => f.endsWith(".md"))
        .map(async (f) => {
          const id = f.replace(/\.md$/, "");
          const meta = await readNoteMeta(id);
          return {
            id: meta.id,
            title: meta.title,
            updatedAt: meta.updatedAt,
          };
        })
    );
    notes.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ notes, workspace: WORKSPACE, media: MEDIA_DIR });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/notes", async (req, res) => {
  try {
    await ensureDirs();
    const id = nanoid(10);
    const title = (req.body?.title || "Untitled").trim() || "Untitled";
    const content = `# ${title}\n\n`;
    await fs.writeFile(notePath(id), content, "utf8");
    await fs.mkdir(mediaNoteDir(id), { recursive: true });
    const meta = await readNoteMeta(id);
    res.status(201).json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/notes/:id", async (req, res) => {
  try {
    const meta = await readNoteMeta(req.params.id);
    res.json(meta);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.put("/api/notes/:id", async (req, res) => {
  try {
    const content = String(req.body?.content ?? "");
    await fs.writeFile(notePath(req.params.id), content, "utf8");
    const meta = await readNoteMeta(req.params.id);
    res.json(meta);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  try {
    await fs.unlink(notePath(req.params.id));
    await fs.rm(mediaNoteDir(req.params.id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post(
  "/api/notes/:id/images",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No image uploaded" });
        return;
      }

      // Ensure note exists
      await fs.access(notePath(req.params.id));

      const dir = mediaNoteDir(req.params.id);
      await fs.mkdir(dir, { recursive: true });

      const original = req.file.originalname || "paste.png";
      const ext =
        path.extname(original).toLowerCase() ||
        mimeToExt(req.file.mimetype) ||
        ".png";
      const safeBase = path
        .basename(original, path.extname(original))
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "paste";
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      const filename = `${stamp}_${safeBase}${ext}`;
      const abs = path.join(dir, filename);
      await fs.writeFile(abs, req.file.buffer);

      const rel = path.posix.join("media", req.params.id, filename);
      res.status(201).json({
        filename,
        path: abs,
        url: `/media/${req.params.id}/${filename}`,
        markdown: `![](${rel})`,
        relative: rel,
      });
    } catch (err) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Note not found" });
        return;
      }
      console.error(err);
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

app.post("/api/reveal-media", async (req, res) => {
  try {
    await ensureDirs();
    const noteId = req.body?.noteId;
    const target = noteId ? mediaNoteDir(noteId) : MEDIA_DIR;
    await fs.mkdir(target, { recursive: true });
    await open(target);
    res.json({ ok: true, path: target });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/workspace", async (_req, res) => {
  await ensureDirs();
  res.json({
    workspace: WORKSPACE,
    notes: NOTES_DIR,
    media: MEDIA_DIR,
    home: os.homedir(),
  });
});

function mimeToExt(mime) {
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  };
  return map[mime] || "";
}

await ensureDirs();
app.listen(PORT, () => {
  console.log(`Binnote server on http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Media bin: ${MEDIA_DIR}`);
});
