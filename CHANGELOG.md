# Changelog

## 0.1.3

- Updated repository references after renaming the GitHub repository to `diegomarzaa/obsidian-extensions-sync-manager`.
- Added a release workflow for future tags that publishes `main.js`, `manifest.json`, and `styles.css`.
- Added GitHub artifact attestations for future release assets using `actions/attest@v4`.
- Replaced direct Node.js filesystem access with Obsidian's vault adapter for profile scanning, copying, backups, and removal.
- Removed the one-time import flow for older external sync files now that state lives in `data.json`.

## 0.1.2

- Renamed the manifest ID to `extensions-sync-manager`.
- Removed remaining user-facing "plugin" naming where it was not an Obsidian technical term.

## 0.1.1

- Renamed the visible app name to `Extensions Sync Manager` to satisfy the Obsidian community directory requirement.

## 0.1.0

- First alpha release.
