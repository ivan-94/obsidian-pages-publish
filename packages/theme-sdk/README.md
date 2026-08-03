# `@pages-publish/theme-sdk`

Stable, dependency-free presentation contract for executable Pages Publish Quartz themes.

```ts
import { defineTheme } from '@pages-publish/theme-sdk';

export default defineTheme({
  layout: {
    frames: {
      home: 'BrutalistPoster',
      content: 'BrutalistEditorial',
    },
  },
  styles: ['./dist/theme.css'],
});
```

The SDK only describes presentation. Content discovery, visibility, routes, canonical URLs and publication remain owned by Pages Publish. The host validates the packed theme descriptor again before use.

## Source Manifest

- Source: [`CUSTOM-QUARTZ-THEME-SPEC.md`](../../CUSTOM-QUARTZ-THEME-SPEC.md), sections 5 and 15.
- Produced artifact: an independently packable `@pages-publish/theme-sdk` package.
- Key decision: the package has no Pages Publish, Quartz, filesystem or network dependency.
- Verification: `npm run build:theme-sdk` and package-content tests in the root project.
