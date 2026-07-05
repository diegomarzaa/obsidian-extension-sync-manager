# Extensions Sync Manager

Manage two Obsidian configuration profiles from one vault, usually a desktop profile in `.obsidian` and a mobile profile in `.obsidian_mobile`.

The app shows extensions and base JSON configuration files side by side, lets you choose the desired state, and applies copy, install, remove, enable, disable, and single-value config changes with backups.

## Features

- Compare desktop and mobile extension folders by content hash.
- Keep extension code and extension configuration together when copying an extension.
- Mark extensions as both devices, PC only, mobile only, frozen, ignored, or remove completely.
- Configure enabled or disabled state independently for PC and mobile.
- Review base configuration JSON differences by value.
- Copy a single changed JSON property from one profile to the other.
- Refresh baseline hashes to track future changes.
- Back up target files before overwrite or removal actions.

## Requirements

Extensions Sync Manager is desktop-only because it uses Node.js file-system APIs to read, copy, and remove files inside hidden Obsidian configuration folders.

## Settings

Open Obsidian settings, then Extensions Sync Manager.

- Desktop config folder: defaults to `.obsidian`.
- Mobile config folder: defaults to `.obsidian_mobile`.
- Backup folder: defaults to `.obsidian/plugins/extensions-sync-manager/backups`.

Settings, policy, and baseline state are stored in `data.json`, the standard Obsidian data file.

## Privacy

Extensions Sync Manager does not use the network, telemetry, accounts, ads, or an auto-update mechanism.

This app accesses files inside your vault, including hidden Obsidian configuration folders such as `.obsidian` and `.obsidian_mobile`. It can copy, overwrite, and remove extension/configuration files only after you click an action and confirm it.

## Installation

For manual installation, copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/extensions-sync-manager/
```

Then enable Extensions Sync Manager from Obsidian community settings.

## License

MIT.
