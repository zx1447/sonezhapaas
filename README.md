# InkWell - Personal Journaling Platform

A lightweight, private diary and journaling web application with
session-based authentication, mood tracking, tagging, calendar view,
bookmarks, activity logging, themes, import/export, and full CRUD
operations for daily journal entries.

## Quick start (Docker)

```bash
docker build -t inkwell .
docker run -d -p 3000:3000 -e PANEL_PASSWORD=admin inkwell
```

Or with Docker Compose:

```bash
docker compose up -d
```

Then open http://localhost:3000

## Quick start (Node.js)

```bash
npm install
npm start
```

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `SERVER_PORT` | Pterodactyl assigned port (highest priority) | - |
| `PORT` | Web panel listening port | `3000` |
| `PANEL_PASSWORD` | Access password for the web panel | `admin` |
| `DATA_DIR` | Directory for data storage | app directory |

## License

MIT
