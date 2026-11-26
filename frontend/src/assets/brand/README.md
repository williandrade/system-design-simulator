# Willi's Overengineer-inator branding

`logo.svg` is the source artwork. The browser and playground use its copy at
`frontend/src/favicon.svg`. The asset generator keeps the original proportions
when rendering the browser fallbacks, PWA icons and social image.

From the repository root, regenerate the web assets with:

```sh
node frontend/scripts/generate-brand-assets.mjs
```

The macOS packager uses the same source to generate a multi-resolution
`.icns` with the system `iconutil` during each desktop build. The icon is included
in the signed `.app`.
