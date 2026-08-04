# Changelog

Pages Publish follows [Semantic Versioning](https://semver.org/). Beta builds are distributed through GitHub Releases and BRAT.

## [Unreleased]

## [0.1.0-beta.2] - 2026-08-04

### Fixed

- Open OAuth, preview and published-site URLs in the macOS system browser instead of an Obsidian web view, preserving Cloudflare authorization cookies in one browser session.
- Report Cloudflare `request_forbidden` callbacks as a lost browser session instead of incorrectly describing them as user cancellation.

## [0.1.0-beta.1] - 2026-08-04

### Added

- Obsidian-native setup, settings, current-note controls and publishing center.
- Local-first site configuration, content scanning, validation and preview.
- Quartz site generation with Markdown, Wiki links, images, Mermaid, search and graph support.
- Public, unlisted and private visibility with negative privacy checks.
- Cloudflare OAuth and API Token connection flows.
- Cloudflare Pages project creation, immutable deployment snapshots and update publishing.
- Quartz native default theme plus optional built-in and external theme selection.
- BRAT-compatible GitHub Release packaging.

### Known limitations

- Beta support is currently limited to macOS Obsidian Desktop.
- Complete keyboard, assistive-technology, multi-account and restricted-token matrices remain in progress.
- Built-in themes other than Quartz default may expose compatibility differences inherited from their Obsidian CSS.

[Unreleased]: https://github.com/ivan-94/obsidian-pages-publish/compare/0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/ivan-94/obsidian-pages-publish/compare/0.1.0-beta.1...0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/ivan-94/obsidian-pages-publish/releases/tag/0.1.0-beta.1
