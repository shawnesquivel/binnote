# Binnote

Local markdown notes that behave a little like Notion — type freely, paste images, and every image lands on disk so you can grab it later in Premiere Pro.

## MVP

- Create / open / delete markdown notes
- Notion-like editing surface (markdown under the hood)
- Paste or drop images → saved into `workspace/media/<note-id>/`
- Notes auto-save as `.md` files with relative image links
- **Open media folder** jumps straight to the files on disk

## Quick start

```bash
npm run install:all
npm start
```

Open [http://localhost:5173](http://localhost:5173).

- API: `http://localhost:8787`
- Notes: `workspace/notes/`
- Images: `workspace/media/`

## How images work

1. Paste (`⌘/Ctrl+V`) or drop an image into a note
2. Binnote writes a timestamped file under `workspace/media/<note-id>/`
3. The note stores a relative markdown image, e.g. `![](media/abc123/2026-09-04_11-15-00_paste.png)`
4. Click **Open media folder** when you need those files in Premiere

## Stack

- Vite + React + TipTap (editor)
- Express (local filesystem API)
- Plain files only — no database, no cloud

## Not in MVP

Blocks / databases, sync, multiplayer, rich embeds beyond images.
