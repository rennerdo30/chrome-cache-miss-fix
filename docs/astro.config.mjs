import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeGalaxy from "starlight-theme-galaxy";

export default defineConfig({
  site: "https://rennerdo30.github.io/chrome-cache-miss-fix",
  base: "/chrome-cache-miss-fix",
  integrations: [
    starlight({
      title: "Cache Miss Fix",
      description:
        "Chrome extension that repairs tabs failing with ERR_CACHE_MISS after a session restore",
      plugins: [starlightThemeGalaxy()],
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/rennerdo30/chrome-cache-miss-fix",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Configuration", slug: "getting-started/configuration" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "How It Works", slug: "guides/how-it-works" },
            { label: "Preventive Mode", slug: "guides/preventive-mode" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
            { label: "Privacy", slug: "guides/privacy" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "Development", slug: "reference/development" }],
        },
      ],
    }),
  ],
});
