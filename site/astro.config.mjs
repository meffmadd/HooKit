// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import {
  rehypeCode,
  remarkCodeTab,
  remarkHeading,
  remarkNpm,
  remarkStructure,
} from 'fumadocs-core/mdx-plugins';
import { rehypeGlossaryTooltips, remarkGlossaryLinks } from './src/glossary-link';

const remarkPlugins = [
  // Canonical computed form: `[pluginFactory, options]`. Registering the
  // factory (not an invoked transformer) is what lets the MDX remark
  // pipeline call it per file — a live transformer would be mistaken for a
  // plugin function and silently dropped.
  [remarkGlossaryLinks, { oncePerPage: true }],
  remarkHeading,
  remarkCodeTab,
  remarkNpm,
  [remarkStructure, { exportAs: 'structuredData' }],
];
const rehypePlugins = [rehypeGlossaryTooltips, rehypeCode];

export default defineConfig({
  redirects: {
    '/reference/action': '/reference/configuration/action',
    '/reference/filter': '/reference/configuration/filter',
    '/reference/hook-result': '/reference/events',
    '/reference/configuration/hook-result': '/reference/events',
    '/reference/presets-sources': '/reference/configuration/presets-sources',
  },
  markdown: {
    processor: unified({
      syntaxHighlight: false,
      remarkPlugins,
      rehypePlugins,
    }),
  },
  integrations: [
    react(),
    mdx({
      extendMarkdownConfig: true,
      syntaxHighlight: false,
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
