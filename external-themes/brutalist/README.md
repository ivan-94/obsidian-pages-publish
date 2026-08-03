# Brutalist UI for Pages Publish

An external Quartz 5 theme implementing the approved poster/editorial/instrument design. It is intentionally packaged independently from the Pages Publish Obsidian plugin.

```bash
npm run test
npm run build
npm pack --pack-destination artifacts
```

Import the resulting `.tgz` from the Pages Publish theme settings. The package contains built output only and requires no install lifecycle or dynamic dependency installation.

Options:

- `wordmark`: publication mark shown by the masthead;
- `accent`: orange, red, blue or acid;
- `homeHero`: latest, section or fixed;
- `showPublicCount`: show the public-index status marker;
- `graphMode`: compact or expanded-on-demand.
